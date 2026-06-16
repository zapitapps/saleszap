// ============================================================
// VendrAI Backend — index.js COMPLETE v3.0
// ONE FILE. Upload to GitHub. Nothing else to paste or add.
// Includes: Auth + Onboarding + Queue System + Templates +
//           WhatsApp Bot + AI + Paystack + CRM + Broadcasts
// ============================================================
"use strict";
try { require("dotenv").config(); } catch(e) {}

const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const axios     = require("axios");
const crypto    = require("crypto");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app  = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL         || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(morgan("combined"));
app.use("/webhook/paystack", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
const authLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many attempts. Wait 1 minute." } });

// ============================================================
// PLAN LIMITS
// ============================================================
const PLAN_LIMITS = {
  free:    { reply_limit:100,    product_limit:5,    contact_limit:100,   broadcast_limit:0,    kb_limit:20,   ai_enabled:true,  broadcasts_enabled:false, analytics:false, excel_import:false, remove_watermark:false },
  starter: { reply_limit:500,    product_limit:20,   contact_limit:500,   broadcast_limit:100,  kb_limit:100,  ai_enabled:true,  broadcasts_enabled:true,  analytics:false, excel_import:false, remove_watermark:true  },
  growth:  { reply_limit:3000,   product_limit:100,  contact_limit:5000,  broadcast_limit:500,  kb_limit:500,  ai_enabled:true,  broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
  pro:     { reply_limit:999999, product_limit:9999, contact_limit:99999, broadcast_limit:9999, kb_limit:9999, ai_enabled:true,  broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
};

const WATERMARK = "\n\n_Powered by VendrAI_ 🤖 | vendrai.app";
const HF_MODEL  = "Qwen/Qwen2.5-72B-Instruct";
const HF_API    = "https://api-inference.huggingface.co/models/";

// ============================================================
// MESSAGE QUEUE SYSTEM
// Handles WhatsApp rate limits (80 MPS max)
// Prevents server crashes during large broadcasts
// ============================================================
class MessageQueue {
  constructor() {
    this.queues     = new Map(); // one queue per business
    this.processing = new Map();
    this.MPS_LIMIT  = 60;       // 60/sec — safe under Meta's 80 MPS limit
    this.DELAY_MS   = Math.ceil(1000 / this.MPS_LIMIT);
    this.stats      = { sent: 0, failed: 0, queued: 0 };
  }

  add(businessId, phoneNumberId, accessToken, to, message) {
    if (!this.queues.has(businessId)) this.queues.set(businessId, []);
    this.queues.get(businessId).push({ phoneNumberId, accessToken, to, message, addedAt: Date.now() });
    this.stats.queued++;
    if (!this.processing.get(businessId)) this.processQueue(businessId);
  }

  async processQueue(businessId) {
    this.processing.set(businessId, true);
    const queue = this.queues.get(businessId);
    while (queue && queue.length > 0) {
      const job = queue.shift();
      try {
        await sendWhatsAppMessage(job.phoneNumberId, job.accessToken, job.to, job.message);
        this.stats.sent++;
        // Log to DB
        await supabase.from("message_queue_log").insert({
          business_id: businessId, to_phone: job.to,
          message: job.message.substring(0, 200),
          status: "sent", attempts: 1, sent_at: new Date().toISOString(),
        }).catch(() => {}); // non-blocking
      } catch (err) {
        this.stats.failed++;
        console.error(`Queue send failed to ${job.to}:`, err.message);
        await supabase.from("message_queue_log").insert({
          business_id: businessId, to_phone: job.to,
          message: job.message.substring(0, 200),
          status: "failed", attempts: 1, error_msg: err.message,
        }).catch(() => {});
      }
      await sleep(this.DELAY_MS);
    }
    this.processing.set(businessId, false);
  }

  status(businessId) {
    return {
      pending:    this.queues.get(businessId)?.length || 0,
      processing: this.processing.get(businessId) || false,
      stats:      this.stats,
    };
  }

  clear(businessId) {
    this.queues.set(businessId, []);
  }
}

const msgQueue = new MessageQueue();

// ============================================================
// UTILITIES
// ============================================================

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + (process.env.ADMIN_SECRET_TOKEN || "vendrai")).digest("hex");
}
function generateOTP()   { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateToken() { return crypto.randomBytes(32).toString("hex"); }
function generateReferralCode() { return "VND-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// REAL OTP DELIVERY SYSTEM
// Method 1: Email via Brevo (free 300/day) — PRIMARY
// Method 2: WhatsApp via your bot number — FALLBACK
// Method 3: SMS via Termii (optional paid)
// ============================================================

async function sendOTPEmail(email, otp, type = "verify", businessName = "VendrAI") {
  // Always log to console (for debugging in Render logs)
  console.log(`📧 OTP for ${email}: ${otp} (type: ${type})`);

  const BREVO_KEY = process.env.BREVO_API_KEY;

  // If no Brevo key, OTP is available in Render logs
  if (!BREVO_KEY) {
    console.warn("⚠️ BREVO_API_KEY not set — OTP only in logs. Set it in Render env vars.");
    return { sent: false, method: "logs_only", otp };
  }

  const subjects = {
    email_verify:   `Your VendrAI verification code: ${otp}`,
    password_reset: `Reset your VendrAI password — Code: ${otp}`,
    login:          `Your VendrAI login code: ${otp}`,
  };

  const bodies = {
    email_verify: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0B0F1A;color:#E2E8F0;padding:30px;border-radius:16px;">
        <div style="text-align:center;margin-bottom:24px;">
          <div style="background:linear-gradient(135deg,#25D366,#128C7E);width:50px;height:50px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;">🤖</div>
          <h1 style="color:#25D366;font-size:1.4rem;margin:10px 0 4px;">VendrAI</h1>
          <p style="color:#64748B;font-size:.85rem;margin:0;">AI WhatsApp Automation for African SMEs</p>
        </div>
        <h2 style="text-align:center;font-size:1.1rem;margin-bottom:8px;">Verify Your Email</h2>
        <p style="color:#94A3B8;text-align:center;font-size:.88rem;margin-bottom:24px;">Enter this code to verify your email and activate your account:</p>
        <div style="background:#111827;border:2px solid rgba(37,211,102,.3);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
          <div style="font-size:2.5rem;font-weight:900;letter-spacing:.3em;color:#25D366;">${otp}</div>
          <div style="color:#64748B;font-size:.78rem;margin-top:8px;">Expires in 10 minutes</div>
        </div>
        <p style="color:#64748B;font-size:.78rem;text-align:center;">If you did not create a VendrAI account, please ignore this email.</p>
      </div>`,
    password_reset: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0B0F1A;color:#E2E8F0;padding:30px;border-radius:16px;">
        <h2 style="color:#25D366;text-align:center;">Reset Your Password</h2>
        <p style="color:#94A3B8;text-align:center;">Use this code to reset your VendrAI password:</p>
        <div style="background:#111827;border:2px solid rgba(37,211,102,.3);border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
          <div style="font-size:2.5rem;font-weight:900;letter-spacing:.3em;color:#25D366;">${otp}</div>
          <div style="color:#64748B;font-size:.78rem;margin-top:8px;">Expires in 10 minutes</div>
        </div>
        <p style="color:#64748B;font-size:.78rem;text-align:center;">If you did not request this, please ignore.</p>
      </div>`,
  };

  try {
    const response = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender:  { name: "VendrAI", email: process.env.BREVO_SENDER_EMAIL || "noreply@vendrai.app" },
        to:      [{ email }],
        subject: subjects[type] || `Your VendrAI code: ${otp}`,
        htmlContent: bodies[type] || `<p>Your VendrAI code is: <strong>${otp}</strong>. Expires in 10 minutes.</p>`,
      },
      {
        headers: {
          "api-key":      BREVO_KEY,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    console.log(`✅ Email OTP sent to ${email} via Brevo`);
    return { sent: true, method: "brevo_email" };
  } catch (err) {
    console.error(`❌ Brevo email failed for ${email}:`, err.response?.data?.message || err.message);
    // Try WhatsApp fallback
    return await sendOTPWhatsApp(email, otp, type);
  }
}

async function sendOTPWhatsApp(identifier, otp, type = "verify") {
  // Send OTP via your platform WhatsApp number
  // identifier can be phone number or email (we need phone)
  const WA_PHONE_ID    = process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
  const WA_TOKEN       = process.env.WA_ACCESS_TOKEN;
  const PLATFORM_PHONE = process.env.SHARED_WA_NUMBER || "";

  if (!WA_PHONE_ID || !WA_TOKEN) {
    console.warn("⚠️ WhatsApp OTP fallback not configured. OTP is in Render logs.");
    return { sent: false, method: "logs_only" };
  }

  // Only works if identifier is a phone number
  const isPhone = /^\+[1-9]\d{7,14}$/.test(identifier);
  if (!isPhone) {
    console.warn(`⚠️ Cannot send WhatsApp OTP to email ${identifier} — no phone number available`);
    return { sent: false, method: "logs_only" };
  }

  const messages = {
    email_verify:   `🤖 *VendrAI Verification*\n\nYour verification code is:\n\n*${otp}*\n\nThis code expires in 10 minutes.\n\nDo not share this code with anyone.`,
    password_reset: `🔑 *VendrAI Password Reset*\n\nYour reset code is:\n\n*${otp}*\n\nThis code expires in 10 minutes.`,
    login:          `🔐 *VendrAI Login Code*\n\nYour one-time login code:\n\n*${otp}*\n\nExpires in 10 minutes.`,
  };

  try {
    await sendWhatsAppMessage(WA_PHONE_ID, WA_TOKEN, identifier, messages[type] || messages.email_verify);
    console.log(`✅ WhatsApp OTP sent to ${identifier}`);
    return { sent: true, method: "whatsapp" };
  } catch (err) {
    console.error(`❌ WhatsApp OTP failed:`, err.message);
    return { sent: false, method: "logs_only" };
  }
}

// Send a WhatsApp notification (order alerts, payment alerts etc)
async function sendBusinessNotification(businessId, message) {
  try {
    const { data: biz } = await supabase
      .from("businesses")
      .select("phone, contact_phone")
      .eq("id", businessId)
      .single();

    const phone = biz?.contact_phone || biz?.phone;
    if (!phone) return;

    const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
    const WA_TOKEN    = process.env.WA_ACCESS_TOKEN;
    if (!WA_PHONE_ID || !WA_TOKEN) return;

    await sendWhatsAppMessage(WA_PHONE_ID, WA_TOKEN, phone, message);
  } catch (err) {
    console.error("Business notification failed:", err.message);
  }
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  if (/\b(abeg|wahala|oga|wetin|dey|sabi|sharp sharp)\b/i.test(t)) return "pidgin";
  if (/\b(ẹ|ọ|ṣe|bawo|elo ni|ese)\b/i.test(t)) return "yo";
  if (/\b(ndewo|nnọọ|biko|igbo)\b/i.test(t)) return "ig";
  if (/\b(sannu|nawa ne|don allah|aboki)\b/i.test(t)) return "ha";
  return "en";
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(hi|hello|hey|good morning|good evening|howdy)\b/i.test(t)) return "greeting";
  if (/\b(order|buy|purchase|i want|i need|place order)\b/i.test(t)) return "order";
  if (/\b(price|how much|cost|fee|rate|naira|abeg how much)\b/i.test(t)) return "price";
  if (/\b(track|status|where is|my order|order status)\b/i.test(t)) return "track";
  if (/\b(pay|payment|bank|transfer|card|mobile money|paystack)\b/i.test(t)) return "payment";
  if (/\b(deliver|ship|shipping|how long|delivery)\b/i.test(t)) return "delivery";
  if (/\b(contact|phone|email|call|human|agent|support)\b/i.test(t)) return "contact";
  if (/\b(catalog|product|shop|browse|list|stock)\b/i.test(t)) return "product";
  if (/\b(cancel|return|refund)\b/i.test(t)) return "cancel";
  return "general";
}

function fuzzyMatch(text, keyword) {
  const tw = text.toLowerCase().split(/\s+/);
  const kw = keyword.toLowerCase().split(/\s+/);
  return kw.filter(k => tw.some(t => t.includes(k) || k.includes(t))).length / kw.length;
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Not logged in. Please log in first." });

  const { data: session } = await supabase
    .from("sessions").select("*, businesses(*)")
    .eq("session_token", token).eq("is_active", true)
    .gt("expires_at", new Date().toISOString()).single();

  if (!session) return res.status(401).json({ error: "Session expired. Please log in again." });

  await supabase.from("sessions").update({ last_used_at: new Date().toISOString() }).eq("id", session.id);
  req.business = session.businesses;
  req.session  = session;
  next();
}

function requirePlan(feature) {
  return (req, res, next) => {
    const limits = PLAN_LIMITS[req.business?.plan] || PLAN_LIMITS.free;
    if (!limits[feature]) {
      return res.status(403).json({
        error: `This feature requires a higher plan.`,
        feature, current_plan: req.business?.plan,
        upgrade_url: `${process.env.FRONTEND_URL}/pricing.html`,
      });
    }
    next();
  };
}

// ============================================================
// AUTH ROUTES
// ============================================================

// POST /auth/register
app.post("/auth/register", authLimiter, async (req, res) => {
  try {
    const { username, email, phone, password, businessName, referralCode } = req.body;

    if (!username || !email || !phone || !password || !businessName)
      return res.status(400).json({ error: "All fields required: username, email, phone, password, businessName" });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
      return res.status(400).json({ error: "Username: 3-30 chars, letters/numbers/underscores only." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (!/^\+[1-9]\d{7,14}$/.test(phone))
      return res.status(400).json({ error: "Phone must include country code. Example: +2348012345678" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    const { data: eu } = await supabase.from("businesses").select("id").eq("username", username.toLowerCase()).single();
    if (eu) return res.status(409).json({ error: "Username already taken. Please choose another." });
    const { data: ee } = await supabase.from("businesses").select("id").eq("email", email.toLowerCase()).single();
    if (ee) return res.status(409).json({ error: "Email already registered. Try logging in instead." });
    const { data: ep } = await supabase.from("businesses").select("id").eq("phone", phone).single();
    if (ep) return res.status(409).json({ error: "Phone number already registered." });

    let referrerId = null;
    if (referralCode) {
      const { data: ref } = await supabase.from("businesses").select("id").eq("referral_code", referralCode).single();
      if (ref) referrerId = ref.id;
    }

    const { data: biz, error: bizErr } = await supabase.from("businesses").insert({
      username: username.toLowerCase(), email: email.toLowerCase(),
      phone, password_hash: hashPassword(password),
      business_name: businessName, whatsapp_number: phone,
      referral_code: generateReferralCode(), referred_by: referrerId,
      plan: "free", reply_limit: 100,
    }).select().single();
    if (bizErr) throw bizErr;

    await supabase.from("business_settings").insert({ business_id: biz.id, wa_verify_token: generateToken().substring(0, 20) });
    await supabase.from("subscriptions").insert({ business_id: biz.id, plan: "free", status: "trial" });

    const { data: templates } = await supabase.from("default_kb_templates").select("*");
    if (templates?.length) {
      await supabase.from("knowledge_base").insert(
        templates.map(t => ({ business_id: biz.id, keyword: t.keyword, answer: t.answer, category: t.category, language: t.language }))
      );
    }

    if (referrerId) {
      await supabase.from("referrals").insert({ referrer_id: referrerId, referred_id: biz.id, referral_code: referralCode, status: "signed_up" });
      const { data: ref } = await supabase.from("businesses").select("referral_count").eq("id", referrerId).single();
      await supabase.from("businesses").update({ referral_count: (ref?.referral_count || 0) + 1 }).eq("id", referrerId);
    }

    // Send real OTP via Brevo email (falls back to WhatsApp)
    const otp = generateOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "email_verify", otp_code: otp });
    const otpResult = await sendOTPEmail(email.toLowerCase(), otp, "email_verify");
    // Also try WhatsApp if email fails and we have phone
    if (!otpResult.sent && phone) {
      await sendOTPWhatsApp(phone, otp, "email_verify");
    }

    const sessionToken = generateToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });

    res.status(201).json({
      success: true,
      message: "✅ Account created! 14-day free trial started.",
      session_token: sessionToken,
      business: { id: biz.id, username: biz.username, businessName: biz.business_name, email: biz.email, phone: biz.phone, plan: "free", referralCode: biz.referral_code },
      next_step: "choose_business_type",
    });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// POST /auth/login
app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: "Username/email and password required." });

    const { data: biz } = await supabase.from("businesses").select("*")
      .or(`username.eq.${identifier.toLowerCase()},email.eq.${identifier.toLowerCase()}`).single();

    if (!biz) return res.status(401).json({ error: "No account found with that username or email." });
    if (biz.password_hash !== hashPassword(password)) return res.status(401).json({ error: "Incorrect password." });
    if (biz.is_suspended) return res.status(403).json({ error: `Account suspended: ${biz.suspension_reason || "Contact support."}` });

    const sessionToken = generateToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });
    await supabase.from("businesses").update({ last_login_at: new Date().toISOString() }).eq("id", biz.id);

    res.json({
      success: true,
      message: "✅ Login successful!",
      session_token: sessionToken,
      business: {
        id: biz.id, username: biz.username, businessName: biz.business_name,
        email: biz.email, phone: biz.phone, plan: biz.plan,
        referralCode: biz.referral_code, emailVerified: biz.email_verified,
        replyCount: biz.reply_count, replyLimit: biz.reply_limit,
        isTrial: biz.is_trial, trialEndsAt: biz.trial_ends_at,
        templateApplied: biz.template_applied,
        planLimits: PLAN_LIMITS[biz.plan] || PLAN_LIMITS.free,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /auth/logout
app.post("/auth/logout", requireAuth, async (req, res) => {
  await supabase.from("sessions").update({ is_active: false }).eq("id", req.session.id);
  res.json({ success: true, message: "✅ Logged out." });
});

// POST /auth/logout-all
app.post("/auth/logout-all", requireAuth, async (req, res) => {
  await supabase.from("sessions").update({ is_active: false }).eq("business_id", req.business.id);
  res.json({ success: true, message: "✅ Logged out from all devices." });
});

// POST /auth/verify-email
app.post("/auth/verify-email", requireAuth, async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: "OTP code is required." });
    const { data: record } = await supabase.from("otp_verifications").select("*")
      .eq("identifier", req.business.email).eq("type", "email_verify").eq("used", false)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).single();
    if (!record) return res.status(400).json({ error: "OTP expired or not found. Request a new one." });
    if (record.otp_code !== otp) return res.status(400).json({ error: "Incorrect OTP. Please try again." });
    await supabase.from("businesses").update({ email_verified: true }).eq("id", req.business.id);
    await supabase.from("otp_verifications").update({ used: true }).eq("id", record.id);
    res.json({ success: true, message: "✅ Email verified!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/resend-otp
app.post("/auth/resend-otp", requireAuth, async (req, res) => {
  const otp = generateOTP();
  await supabase.from("otp_verifications").insert({ identifier: req.business.email, type: "email_verify", otp_code: otp });
  const r = await sendOTPEmail(req.business.email, otp, "email_verify");
  if (!r.sent && req.business.phone) await sendOTPWhatsApp(req.business.phone, otp, "email_verify");
  res.json({ success: true, message: "✅ New verification code sent." });
});

// POST /auth/forgot-password
app.post("/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const { data: biz } = await supabase.from("businesses").select("id").eq("email", email?.toLowerCase()).single();
    if (!biz) return res.status(404).json({ error: "No account found with that email." });
    const otp = generateOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "password_reset", otp_code: otp });
    await sendOTPEmail(email.toLowerCase(), otp, "password_reset");
    res.json({ success: true, message: "✅ Reset code sent to your email." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/reset-password
app.post("/auth/reset-password", authLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: "Email, OTP and new password required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const { data: record } = await supabase.from("otp_verifications").select("*")
      .eq("identifier", email.toLowerCase()).eq("type", "password_reset").eq("used", false)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).single();
    if (!record || record.otp_code !== otp) return res.status(400).json({ error: "Invalid or expired reset code." });
    await supabase.from("businesses").update({ password_hash: hashPassword(newPassword) }).eq("email", email.toLowerCase());
    await supabase.from("otp_verifications").update({ used: true }).eq("id", record.id);
    res.json({ success: true, message: "✅ Password reset! Please log in with your new password." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const biz = req.business;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", biz.id).single();
    const { data: stats }    = await supabase.from("business_dashboard").select("*").eq("id", biz.id).single();
    if (settings?.wa_access_token) settings.wa_access_token = settings.wa_access_token.substring(0, 20) + "...";
    if (settings?.paystack_secret) settings.paystack_secret = "sk_***hidden***";
    res.json({ success: true, business: { ...biz, settings, stats, planLimits: PLAN_LIMITS[biz.plan] || PLAN_LIMITS.free } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /auth/change-password
app.patch("/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both current and new password required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    if (req.business.password_hash !== hashPassword(currentPassword)) return res.status(401).json({ error: "Current password is incorrect." });
    await supabase.from("businesses").update({ password_hash: hashPassword(newPassword) }).eq("id", req.business.id);
    await supabase.from("sessions").update({ is_active: false }).eq("business_id", req.business.id).neq("id", req.session.id);
    res.json({ success: true, message: "✅ Password changed! Other sessions logged out." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ONBOARDING ROUTES
// ============================================================

// POST /onboarding/business-info
app.post("/onboarding/business-info", requireAuth, async (req, res) => {
  try {
    const { businessName, businessDesc, businessCategory, contactPhone, contactEmail, address, city, state, country, deliveryAreas, deliveryFee, deliveryDays, freeDeliveryAbove } = req.body;
    if (!businessName) return res.status(400).json({ error: "Business name is required." });
    await supabase.from("businesses").update({
      business_name: businessName, business_desc: businessDesc || null,
      business_category: businessCategory || "general",
      contact_phone: contactPhone || null, contact_email: contactEmail || null,
      address: address || null, city: city || null, state: state || null,
      country: country || "Nigeria", delivery_areas: deliveryAreas || [],
      delivery_fee: parseFloat(deliveryFee) || 0,
      delivery_days: deliveryDays || "1-3 business days",
      free_delivery_above: freeDeliveryAbove ? parseFloat(freeDeliveryAbove) : null,
      updated_at: new Date().toISOString(),
    }).eq("id", req.business.id);
    res.json({ success: true, message: "✅ Business info saved!", next_step: "whatsapp" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /onboarding/whatsapp
app.post("/onboarding/whatsapp", requireAuth, async (req, res) => {
  try {
    const { waPhoneId, waAccessToken, waBusinessId, paystackPublic, paystackSecret } = req.body;
    if (!waPhoneId || !waAccessToken) return res.status(400).json({ error: "WhatsApp Phone ID and Access Token required." });
    await supabase.from("business_settings").update({
      wa_phone_id: waPhoneId, wa_access_token: waAccessToken,
      wa_business_id: waBusinessId || null,
      paystack_public: paystackPublic || null,
      paystack_secret: paystackSecret || null,
      updated_at: new Date().toISOString(),
    }).eq("business_id", req.business.id);
    res.json({ success: true, message: "✅ WhatsApp connected! Your bot is ready.", next_step: "bot_messages" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /onboarding/bot-messages
app.post("/onboarding/bot-messages", requireAuth, async (req, res) => {
  try {
    const { greetingMsg, fallbackMsg, awayMsg, aiPersonality, customInstructions, businessHoursStart, businessHoursEnd, timezone } = req.body;
    await supabase.from("business_settings").update({
      greeting_msg: greetingMsg || null, fallback_msg: fallbackMsg || null,
      away_msg: awayMsg || null, ai_personality: aiPersonality || "friendly",
      custom_instructions: customInstructions || null,
      business_hours_start: businessHoursStart || "08:00",
      business_hours_end: businessHoursEnd || "20:00",
      timezone: timezone || "Africa/Lagos",
      updated_at: new Date().toISOString(),
    }).eq("business_id", req.business.id);
    res.json({ success: true, message: "✅ Bot messages saved!", next_step: "done" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /onboarding/apply-template — Apply a business template
app.post("/onboarding/apply-template", requireAuth, async (req, res) => {
  try {
    const { templateCode } = req.body;
    if (!templateCode) return res.status(400).json({ error: "templateCode is required." });

    const { data: template } = await supabase.from("business_type_templates")
      .select("*").eq("code", templateCode).eq("is_active", true).single();
    if (!template) return res.status(404).json({ error: "Business template not found." });

    const bizId  = req.business.id;
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;

    // Load and insert template products
    const { data: tplProducts } = await supabase.from("template_products").select("*").eq("template_id", template.id).order("sort_order");
    let productsAdded = 0;
    if (tplProducts?.length) {
      const { count } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", bizId);
      const canAdd = limits.product_limit - (count || 0);
      const toAdd  = tplProducts.slice(0, canAdd);
      if (toAdd.length > 0) {
        await supabase.from("products").insert(toAdd.map(p => ({
          business_id: bizId, name: p.name, description: p.description,
          price: p.price, sale_price: p.sale_price || null,
          currency: p.currency || "NGN", type: p.type || "physical",
          category: p.category || "general", stock: p.stock || null,
          digital_link: p.digital_link || null,
          keywords: p.keywords || [], tags: p.tags || [],
          is_active: true, imported_from: "template",
        })));
        productsAdded = toAdd.length;
      }
    }

    // Load and insert template KB (replace default entries)
    const { data: tplKB } = await supabase.from("template_kb").select("*").eq("template_id", template.id).order("sort_order");
    let kbAdded = 0;
    if (tplKB?.length) {
      await supabase.from("knowledge_base").delete().eq("business_id", bizId).eq("promoted_from_ai", false);
      const toAddKB = tplKB.slice(0, limits.kb_limit);
      await supabase.from("knowledge_base").insert(toAddKB.map(k => ({
        business_id: bizId, keyword: k.keyword, answer: k.answer,
        category: k.category || "general", language: k.language || "en", is_active: true,
      })));
      kbAdded = toAddKB.length;
    }

    // Apply template settings
    const { data: tplSettings } = await supabase.from("template_settings").select("*").eq("template_id", template.id).single();
    if (tplSettings) {
      await supabase.from("business_settings").update({
        greeting_msg: tplSettings.greeting_msg || null,
        fallback_msg: tplSettings.fallback_msg || null,
        away_msg: tplSettings.away_msg || null,
        ai_personality: tplSettings.ai_personality || "friendly",
        custom_instructions: tplSettings.custom_instructions || null,
        updated_at: new Date().toISOString(),
      }).eq("business_id", bizId);

      if (tplSettings.delivery_areas?.length || tplSettings.delivery_fee) {
        await supabase.from("businesses").update({
          delivery_areas: tplSettings.delivery_areas || [],
          delivery_fee: tplSettings.delivery_fee || 0,
          delivery_days: tplSettings.delivery_days || "1-3 business days",
          business_category: template.category,
          updated_at: new Date().toISOString(),
        }).eq("id", bizId);
      }
    }

    await supabase.from("businesses").update({ template_code: templateCode, template_applied: true, updated_at: new Date().toISOString() }).eq("id", bizId);

    res.json({
      success: true,
      message: `✅ "${template.name}" template applied!`,
      template: { code: template.code, name: template.name, icon: template.icon },
      productsAdded, kbEntriesAdded: kbAdded, settingsApplied: !!tplSettings,
    });
  } catch (err) {
    console.error("Apply template error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /onboarding/status
app.get("/onboarding/status", requireAuth, async (req, res) => {
  try {
    const biz = req.business;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", biz.id).single();
    const { data: products }  = await supabase.from("products").select("id").eq("business_id", biz.id).limit(1);
    const steps = {
      account_created:    true,
      email_verified:     biz.email_verified,
      business_info:      !!(biz.business_desc && biz.city),
      whatsapp_connected: !!(settings?.wa_phone_id && settings?.wa_access_token),
      products_added:     products?.length > 0,
      bot_customized:     biz.template_applied || false,
    };
    const completed = Object.values(steps).filter(Boolean).length;
    res.json({ success: true, steps, progress: `${completed}/${Object.keys(steps).length}`, percent: Math.round((completed / Object.keys(steps).length) * 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TEMPLATES LIBRARY API
// ============================================================

// GET /templates — List all 100 business templates
app.get("/templates", async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = supabase.from("business_type_templates")
      .select("id, code, name, category, icon, description, delivery_type, currency")
      .eq("is_active", true).order("sort_order");
    if (category) query = query.eq("category", category);
    if (search)   query = query.ilike("name", `%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, templates: data, total: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /templates/:code — Preview a single template
app.get("/templates/:code", async (req, res) => {
  try {
    const { data: template } = await supabase.from("business_type_templates").select("*").eq("code", req.params.code).single();
    if (!template) return res.status(404).json({ error: "Template not found." });
    const { data: products } = await supabase.from("template_products").select("*").eq("template_id", template.id).order("sort_order");
    const { data: kb }       = await supabase.from("template_kb").select("*").eq("template_id", template.id).order("sort_order");
    const { data: settings } = await supabase.from("template_settings").select("*").eq("template_id", template.id).single();
    res.json({ success: true, template, preview: { products: products || [], kb: kb || [], settings: settings || null } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PRODUCTS API
// ============================================================

app.get("/api/products", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, search } = req.query;
    let query = supabase.from("products").select("*", { count: "exact" })
      .eq("business_id", req.business.id).order("created_at", { ascending: false })
      .range((page-1)*limit, page*limit-1);
    if (category) query = query.eq("category", category);
    if (search)   query = query.ilike("name", `%${search}%`);
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, products: data, total: count, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/products", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    if ((count || 0) >= limits.product_limit)
      return res.status(403).json({ error: `Product limit (${limits.product_limit}) reached. Upgrade to add more.`, upgrade_url: `${process.env.FRONTEND_URL}/pricing.html` });
    const { name, description, category, price, salePrice, currency, type, stock, digitalLink, digitalCode, imageUrl, keywords, tags, sku } = req.body;
    if (!name || !price) return res.status(400).json({ error: "Product name and price required." });
    const { data, error } = await supabase.from("products").insert({
      business_id: req.business.id, sku: sku || null, name,
      description: description || null, category: category || "general",
      price: parseFloat(price), sale_price: salePrice ? parseFloat(salePrice) : null,
      currency: currency || "NGN", type: type || "physical",
      stock: stock !== undefined && stock !== "" ? parseInt(stock) : null,
      digital_link: digitalLink || null, digital_code: digitalCode || null,
      image_url: imageUrl || null, keywords: keywords || [], tags: tags || [],
      imported_from: "manual",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/products/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("products")
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("products").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products/import — Excel/CSV bulk import
app.post("/api/products/import", requireAuth, requirePlan("excel_import"), async (req, res) => {
  try {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0)
      return res.status(400).json({ error: "No products data found. Check your file format." });
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    const canAdd = limits.product_limit - (count || 0);
    if (canAdd <= 0) return res.status(403).json({ error: `Product limit reached. Upgrade to add more.` });

    const { data: importRecord } = await supabase.from("bulk_imports").insert({
      business_id: req.business.id, type: "products", total_rows: products.length, status: "processing",
    }).select().single();

    const toImport = products.slice(0, canAdd);
    const errors = [];
    const rows = [];

    for (let i = 0; i < toImport.length; i++) {
      const p = toImport[i];
      if (!p.name || !p.price) { errors.push({ row: i+2, error: `Row ${i+2}: name and price required` }); continue; }
      rows.push({
        business_id: req.business.id, sku: p.sku || null,
        name: String(p.name).trim(), description: p.description ? String(p.description).trim() : null,
        category: p.category || "general", price: parseFloat(p.price) || 0,
        sale_price: p.sale_price ? parseFloat(p.sale_price) : null,
        currency: p.currency || "NGN", type: p.type || "physical",
        stock: p.stock !== undefined && p.stock !== "" ? parseInt(p.stock) : null,
        digital_link: p.digital_link || null, digital_code: p.digital_code || null,
        image_url: p.image_url || null,
        keywords: p.keywords ? String(p.keywords).split(",").map(k=>k.trim()) : [],
        tags: p.tags ? String(p.tags).split(",").map(t=>t.trim()) : [],
        imported_from: "excel", import_batch_id: importRecord.id,
      });
    }

    let imported = 0;
    if (rows.length > 0) {
      const { data: inserted } = await supabase.from("products").insert(rows).select();
      imported = inserted?.length || 0;
    }
    await supabase.from("bulk_imports").update({ imported_rows: imported, failed_rows: errors.length, errors, status: "done", completed_at: new Date().toISOString() }).eq("id", importRecord.id);
    res.json({ success: true, message: `✅ ${imported} products imported, ${errors.length} failed.`, imported, failed: errors.length, errors: errors.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/import/template
app.get("/api/products/import/template", requireAuth, (req, res) => {
  res.json({ success: true, message: "Use these column headers in your Excel/CSV:",
    columns: [
      { header: "name", required: true, example: "Red Wig 24inch" },
      { header: "price", required: true, example: "15000" },
      { header: "description", required: false, example: "Beautiful human hair wig" },
      { header: "category", required: false, example: "fashion" },
      { header: "currency", required: false, example: "NGN" },
      { header: "type", required: false, example: "physical" },
      { header: "stock", required: false, example: "50" },
      { header: "sale_price", required: false, example: "12000" },
      { header: "sku", required: false, example: "WIG-001" },
      { header: "digital_link", required: false, example: "https://drive.google.com/..." },
      { header: "digital_code", required: false, example: "LICENSE-ABC123" },
      { header: "keywords", required: false, example: "wig,hair,fashion" },
      { header: "tags", required: false, example: "featured,sale" },
    ]
  });
});

// ============================================================
// DASHBOARD API
// ============================================================

app.get("/dashboard/stats", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("business_dashboard").select("*").eq("id", req.business.id).single();
    if (error) throw error;
    const { data: errs } = await supabase.from("error_reports").select("id").eq("business_id", req.business.id).eq("resolved", false);
    res.json({ success: true, stats: { ...data, unresolved_errors: errs?.length || 0, plan_limits: PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { data, count, error } = await supabase.from("knowledge_base").select("*", { count: "exact" })
      .eq("business_id", req.business.id).order("uses", { ascending: false });
    if (error) throw error;
    res.json({ success: true, entries: data, total: count, limit: limits.kb_limit, can_add: (count || 0) < limits.kb_limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    if ((count || 0) >= limits.kb_limit) return res.status(403).json({ error: `KB limit (${limits.kb_limit}) reached. Upgrade to add more.` });
    const { keyword, answer, category, language } = req.body;
    if (!keyword || !answer) return res.status(400).json({ error: "Keyword and answer required." });
    const { data, error } = await supabase.from("knowledge_base").insert({ business_id: req.business.id, keyword, answer, category: category || "general", language: language || "en" }).select().single();
    if (error) throw error;
    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/dashboard/kb/:id/toggle", requireAuth, async (req, res) => {
  try {
    const { data: entry } = await supabase.from("knowledge_base").select("is_active").eq("id", req.params.id).eq("business_id", req.business.id).single();
    if (!entry) return res.status(404).json({ error: "KB entry not found." });
    const { data, error } = await supabase.from("knowledge_base").update({ is_active: !entry.is_active, updated_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/dashboard/kb/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("knowledge_base").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/ai-logs", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("ai_promotion_candidates").select("*").eq("business_id", req.business.id).limit(50);
    if (error) throw error;
    res.json({ success: true, candidates: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/dashboard/ai-logs/:id/promote", requireAuth, async (req, res) => {
  try {
    const { customAnswer, category, language } = req.body;
    const { data: log } = await supabase.from("ai_logs").select("*").eq("id", req.params.id).single();
    if (!log) return res.status(404).json({ error: "Log not found." });
    const { data: kbEntry, error } = await supabase.from("knowledge_base").insert({
      business_id: log.business_id, keyword: log.incoming_msg.substring(0, 100),
      answer: customAnswer || log.ai_response, category: category || "general",
      language: language || "en", confidence: log.confidence || 0.85, promoted_from_ai: true,
    }).select().single();
    if (error) throw error;
    await supabase.from("ai_logs").update({ promoted_to_kb: true }).eq("id", req.params.id);
    res.json({ success: true, message: "✅ Promoted to KB!", kbEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/contacts", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, tag, segment, search } = req.query;
    let query = supabase.from("contacts").select("*", { count: "exact" })
      .eq("business_id", req.business.id).order("last_seen", { ascending: false })
      .range((page-1)*limit, page*limit-1);
    if (tag)     query = query.contains("tags", [tag]);
    if (segment) query = query.eq("segment", segment);
    if (search)  query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, contacts: data, total: count, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/orders", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    let query = supabase.from("orders").select("*, contacts(name, phone)", { count: "exact" })
      .eq("business_id", req.business.id).order("created_at", { ascending: false })
      .range((page-1)*limit, page*limit-1);
    if (status) query = query.eq("status", status);
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data, total: count, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/dashboard/orders/:id", requireAuth, async (req, res) => {
  try {
    const { status, trackingNumber, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status)         updates.status = status;
    if (trackingNumber) updates.tracking_number = trackingNumber;
    if (notes)          updates.notes = notes;
    const { data, error } = await supabase.from("orders").update(updates).eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/broadcasts", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { data, error } = await supabase.from("broadcasts").select("*").eq("business_id", req.business.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, broadcasts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dashboard/broadcasts/send — Uses queue system for rate limiting
app.post("/dashboard/broadcasts/send", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { title, message, targetTags, targetSegment } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required." });
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (!settings?.wa_phone_id) return res.status(400).json({ error: "WhatsApp not configured. Complete setup first." });

    let query = supabase.from("contacts").select("phone, name").eq("business_id", req.business.id).eq("opted_in", true);
    if (targetTags?.length)  query = query.overlaps("tags", targetTags);
    if (targetSegment)        query = query.eq("segment", targetSegment);
    const { data: contacts } = await query.limit(limits.broadcast_limit);
    if (!contacts?.length) return res.json({ success: false, message: "No contacts found." });

    const { data: broadcast } = await supabase.from("broadcasts").insert({
      business_id: req.business.id, title: title || "Broadcast",
      message, target_tags: targetTags || [], recipients_count: contacts.length, status: "sending",
    }).select().single();

    const accessToken = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;

    // Add all messages to queue (rate-limited automatically)
    for (const contact of contacts) {
      const personalMsg = message.replace("{name}", contact.name || "Friend");
      msgQueue.add(req.business.id, settings.wa_phone_id, accessToken, contact.phone, personalMsg);
    }

    // Update broadcast status after queuing (actual sends happen async)
    await supabase.from("broadcasts").update({ status: "queued", sent_at: new Date().toISOString() }).eq("id", broadcast.id);

    res.json({
      success: true,
      message: `✅ ${contacts.length} messages queued! Sending at 60/second via rate-limited queue.`,
      queued: contacts.length,
      estimatedSeconds: Math.ceil(contacts.length / 60),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/referrals", requireAuth, async (req, res) => {
  try {
    const { data: refs } = await supabase.from("referrals").select("*").eq("referrer_id", req.business.id).order("created_at", { ascending: false });
    res.json({ success: true, referralCode: req.business.referral_code, referralLink: `${process.env.FRONTEND_URL}?ref=${req.business.referral_code}`, totalReferrals: req.business.referral_count || 0, referrals: refs || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (error) throw error;
    if (data?.wa_access_token) data.wa_access_token = data.wa_access_token.substring(0, 20) + "...";
    if (data?.paystack_secret) data.paystack_secret = "sk_***hidden***";
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const allowed = ["greeting_msg","fallback_msg","away_msg","auto_reply","ai_enabled","collect_leads","watermark","away_mode","business_hours_start","business_hours_end","timezone","notify_new_order","notify_payment","notify_email","ai_personality","custom_instructions"];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
    const { data, error } = await supabase.from("business_settings").update(updates).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/dashboard/profile", requireAuth, async (req, res) => {
  try {
    const allowed = ["business_name","business_desc","business_category","contact_phone","contact_email","address","city","state","country","delivery_areas","delivery_fee","delivery_days","free_delivery_above"];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
    const { data, error } = await supabase.from("businesses").update(updates).eq("id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, business: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/queue-status
app.get("/dashboard/queue-status", requireAuth, (req, res) => {
  res.json({ success: true, queue: msgQueue.status(req.business.id), info: "Messages sent at 60/second to respect WhatsApp rate limits" });
});

// ============================================================
// WHATSAPP HELPER FUNCTIONS
// ============================================================

async function sendWhatsAppMessage(phoneNumberId, accessToken, to, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
    return { success: true, messageId: response.data?.messages?.[0]?.id };
  } catch (err) {
    console.error("❌ WA send error:", err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

async function searchKnowledgeBase(businessId, message, language) {
  const { data: entries } = await supabase.from("knowledge_base").select("*")
    .eq("business_id", businessId).eq("is_active", true).in("language", [language, "en"]);
  if (!entries?.length) return null;
  let best = null, bestScore = 0;
  for (const e of entries) {
    const score = fuzzyMatch(message, e.keyword);
    if (score > bestScore) { bestScore = score; best = { ...e, matchScore: score }; }
  }
  if (bestScore >= 0.6) {
    await supabase.from("knowledge_base").update({ uses: best.uses + 1, updated_at: new Date().toISOString() }).eq("id", best.id);
    return best;
  }
  return null;
}

async function callQwenAI(message, business, language, intent, settings) {
  const HF_TOKEN = process.env.HF_API_KEY;
  if (!HF_TOKEN) throw new Error("HF_API_KEY not set");

  const systemPrompt = `You are a ${settings?.ai_personality || "friendly"} WhatsApp sales assistant for "${business.business_name}", an African business.
Business description: ${business.business_desc || "We sell quality products and services."}
Location: ${business.city || ""} ${business.country || "Nigeria"}
Delivery: ${business.delivery_days || "1-3 business days"} | Fee: ${business.currency || "NGN"} ${business.delivery_fee || 0}
${settings?.custom_instructions ? `Special instructions: ${settings.custom_instructions}` : ""}
Rules:
- Keep replies SHORT (under 100 words)
- Be warm and use 1-2 emojis
- Always end with a CTA (Reply ORDER, Type MENU, etc.)
- Never make up prices — say "Type CATALOG for prices"
- Customer intent: ${intent}
- Reply in: ${language === "pidgin" ? "Nigerian Pidgin English" : language === "yo" ? "Yoruba-friendly English" : language === "ha" ? "Hausa-friendly English" : language === "ig" ? "Igbo-friendly English" : "English"}`;

  const start = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(`${HF_API}${HF_MODEL}`,
        { inputs: `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${message}<|im_end|>\n<|im_start|>assistant\n`,
          parameters: { max_new_tokens: 150, temperature: 0.7, top_p: 0.9, return_full_text: false } },
        { headers: { Authorization: `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" }, timeout: 25000 }
      );
      let text = "";
      if (Array.isArray(response.data) && response.data[0]?.generated_text) text = response.data[0].generated_text.trim();
      else if (response.data?.generated_text) text = response.data.generated_text.trim();
      text = text.replace(/<\|im_end\|>/g, "").replace(/<\|im_start\|>/g, "").trim();
      if (!text) throw new Error("Empty response");
      return { text, latency: Date.now() - start, tokens: text.split(" ").length };
    } catch (err) {
      if (attempt < 3) {
        if (err.response?.status === 503) { await sleep(5000); continue; }
        if (err.response?.status === 429) { await sleep(10000); continue; }
      }
      throw err;
    }
  }
}

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

// GET — Verification
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST — Incoming messages (responds in <250ms as Meta requires)
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200); // Always respond immediately — Meta requires <5s

  try {
    const body = req.body;
    if (!body?.object || body.object !== "whatsapp_business_account") return;
    const entry = body.entry?.[0], changes = entry?.changes?.[0], value = changes?.value, messages = value?.messages;
    if (!messages?.length) return;

    const msg             = messages[0];
    const fromPhone       = msg.from;
    const messageText     = msg.text?.body || "";
    const waPhoneNumberId = value?.metadata?.phone_number_id;
    const contactName     = value?.contacts?.[0]?.profile?.name || fromPhone;

    if (!messageText || !fromPhone) return;
    console.log(`📨 From ${fromPhone}: "${messageText}"`);

    const { data: settings } = await supabase.from("business_settings")
      .select("*, businesses(*)").eq("wa_phone_id", waPhoneNumberId).single();
    if (!settings?.businesses) { console.warn(`⚠️ No business for WA ID: ${waPhoneNumberId}`); return; }

    const business     = settings.businesses;
    const plan         = business.plan || "free";
    const planLimits   = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const accessToken  = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const addWatermark = !planLimits.remove_watermark;
    const buildReply   = (t) => addWatermark ? t + WATERMARK : t;

    if (!settings.auto_reply) return;

    // Check reply limit
    const used = business.reply_count || 0, limit = business.reply_limit || 100;
    if (plan !== "pro" && used >= limit) {
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, `⚠️ This business has reached its monthly reply limit. Please contact them directly.`);
      return;
    }

    // Get or create contact
    const { data: existing } = await supabase.from("contacts").select("*").eq("business_id", business.id).eq("phone", fromPhone).single();
    let contact = existing;
    if (existing) {
      await supabase.from("contacts").update({ last_seen: new Date().toISOString() }).eq("id", existing.id);
    } else {
      const { data: newC } = await supabase.from("contacts").insert({ business_id: business.id, phone: fromPhone, name: contactName }).select().single();
      contact = newC;
    }

    const language = detectLanguage(messageText);
    const intent   = detectIntent(messageText);
    const incReply = () => supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);

    // ── MENU ──
    if (/^(menu|help|start|options?)$/i.test(messageText.trim())) {
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
        `🤖 *${business.business_name} — Menu*\n\n🛍️ *CATALOG* — Browse products\n💰 *PRICE* — See prices\n📦 *TRACK [no]* — Track order\n📞 *CONTACT* — Our team\n🚀 *ORDER [name]* — Place order\n\nOr just ask me anything! 😊`
      ));
      await incReply(); return;
    }

    // ── CATALOG / PRICE ──
    if (/^(catalog|products?|shop|browse|list|price|how much)$/i.test(messageText.trim())) {
      const { data: products } = await supabase.from("products").select("name,price,currency,sale_price,type,description").eq("business_id", business.id).eq("is_active", true).limit(10);
      let cat = `🛒 *${business.business_name} — Products*\n\n`;
      if (products?.length) {
        products.forEach((p, i) => {
          const displayPrice = p.sale_price
            ? `~~${p.currency} ${Number(p.price).toLocaleString()}~~ *${p.currency} ${Number(p.sale_price).toLocaleString()}* 🔥`
            : `${p.currency} ${Number(p.price).toLocaleString()}`;
          cat += `${i+1}. *${p.name}*\n   💰 ${displayPrice}\n`;
          if (p.description) cat += `   ${p.description.substring(0,60)}\n`;
          cat += `   ${p.type==="digital"?"⚡ Digital":"📦 Physical"}\n\n`;
        });
        cat += `Reply *ORDER [product name]* to buy!`;
      } else { cat += `No products listed yet. Type *CONTACT* to ask about our products! 😊`; }
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(cat));
      await incReply(); return;
    }

    // ── CONTACT ──
    if (/^(contact|support|human|agent|talk)$/i.test(messageText.trim())) {
      const ph = business.contact_phone || business.phone;
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
        `📞 *Contact ${business.business_name}*\n\nPhone/WhatsApp: ${ph}\n${business.contact_email?`Email: ${business.contact_email}\n`:""}${business.city?`Location: ${business.city}, ${business.state||business.country}\n`:""}\nWe respond within 2 hours! 😊`
      ));
      await incReply(); return;
    }

    // ── DELIVERY ──
    if (/^(delivery|deliver|shipping|ship)$/i.test(messageText.trim())) {
      const areas = business.delivery_areas?.length ? business.delivery_areas.join(", ") : "Nationwide";
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
        `📦 *Delivery Info*\n\n📍 Areas: ${areas}\n⏱️ Time: ${business.delivery_days||"1-3 business days"}\n💰 Fee: ${business.currency||"NGN"} ${Number(business.delivery_fee||0).toLocaleString()}${business.free_delivery_above?`\n🎁 FREE delivery above ${business.currency||"NGN"} ${Number(business.free_delivery_above).toLocaleString()}`:""}\n\nType *ORDER [product]* to buy! 🛍️`
      ));
      await incReply(); return;
    }

    // ── UPGRADE ──
    if (/^(upgrade|subscribe|pricing|plan)$/i.test(messageText.trim())) {
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
        `🚀 *Upgrade VendrAI*\n\n✅ *Starter* — ₦4,900/mo → 500 replies\n✅ *Growth* — ₦14,900/mo → 3,000 replies\n✅ *Pro* — ₦29,900/mo → Unlimited\n\n14-day FREE trial on all plans!\n👉 ${process.env.FRONTEND_URL}/pricing.html`
      ));
      await incReply(); return;
    }

    // ── TRACK ──
    if (/^(track|status)\s+\S+/i.test(messageText.trim())) {
      const orderRef = messageText.trim().split(/\s+/).slice(1).join(" ");
      const { data: ord } = await supabase.from("orders").select("*").eq("business_id", business.id)
        .eq("contact_id", contact?.id).or(`order_number.ilike.%${orderRef}%,id.ilike.${orderRef}%`).single();
      if (ord) {
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
          `📍 *Order Status*\n\n🆔 ${ord.order_number}\n📦 Status: *${ord.status.toUpperCase()}*\n💳 Payment: ${ord.paystack_status}\n📅 ${new Date(ord.created_at).toLocaleDateString()}${ord.tracking_number?`\n🚚 Tracking: ${ord.tracking_number}`:""}\n\nType *CONTACT* for help! 😊`
        ));
        await incReply(); return;
      }
    }

    // ── ORDER ──
    if (/^order\s+.+/i.test(messageText.trim())) {
      const productQuery = messageText.replace(/^order\s+/i, "").trim();
      const { data: prods } = await supabase.from("products").select("*").eq("business_id", business.id).eq("is_active", true);
      let matched = null;
      if (prods) for (const p of prods) { if (fuzzyMatch(productQuery, p.name) > 0.5) { matched = p; break; } }
      if (matched) {
        const price       = matched.sale_price || matched.price;
        const deliveryFee = matched.type === "digital" ? 0 : (business.delivery_fee || 0);
        const total       = price + deliveryFee;
        const { data: order } = await supabase.from("orders").insert({
          business_id: business.id, contact_id: contact?.id,
          order_number: `ORD-${Date.now().toString(36).toUpperCase()}`,
          items: [{ product_id: matched.id, name: matched.name, qty: 1, price, currency: matched.currency }],
          subtotal: price, delivery_fee: deliveryFee, total,
          currency: matched.currency || "NGN", delivery_type: matched.type, status: "pending",
        }).select().single();

        let payLink = "";
        try {
          const secret = settings.paystack_secret || process.env.PAYSTACK_SECRET_KEY;
          const resp = await axios.post("https://api.paystack.co/transaction/initialize",
            { email: `${fromPhone.replace("+","")}@vendrai.app`, amount: total * 100, currency: matched.currency || "NGN",
              reference: `VND-${order.id.substring(0,8).toUpperCase()}`,
              metadata: { order_id: order.id, business_id: business.id, contact_phone: fromPhone },
              callback_url: `${process.env.BACKEND_URL}/webhook/paystack/verify` },
            { headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } }
          );
          payLink = resp.data?.data?.authorization_url || "";
          await supabase.from("orders").update({ payment_link: payLink }).eq("id", order.id);
        } catch (e) { console.error("Paystack error:", e.message); }

        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(
          `✅ *Order Created!*\n\n📦 ${matched.name}\n💰 ${matched.currency} ${Number(price).toLocaleString()}\n🚚 Delivery: ${matched.currency} ${Number(deliveryFee).toLocaleString()}\n💵 *Total: ${matched.currency} ${Number(total).toLocaleString()}*\n🆔 ${order.order_number}\n\n${payLink?`👇 *Pay securely:*\n${payLink}\n\n`:""}⚡ Digital products delivered instantly after payment!`
        ));
        // Notify subscriber of new order via WhatsApp
        sendBusinessNotification(business.id,
          `🛍️ *New Order Alert!*\n\n📦 ${matched.name}\n💰 ${matched.currency} ${Number(total).toLocaleString()}\n📱 Customer: ${fromPhone}\n🆔 ${order.order_number}\n\nLogin to confirm: ${process.env.FRONTEND_URL}/dashboard.html`
        ).catch(() => {});

        await incReply(); return;
      }
    }

    // ── KNOWLEDGE BASE ──
    const kbMatch = await searchKnowledgeBase(business.id, messageText, language);
    if (kbMatch) {
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(kbMatch.answer));
      await incReply();
      await supabase.from("ai_logs").insert({ business_id: business.id, contact_phone: fromPhone, incoming_msg: messageText, ai_response: kbMatch.answer, kb_hit: true, kb_entry_id: kbMatch.id, status: "success", confidence: kbMatch.matchScore }).catch(()=>{});
      return;
    }

    // ── QWEN AI (last resort — only fires on KB miss) ──
    if (settings.ai_enabled !== false && planLimits.ai_enabled) {
      try {
        const aiResult = await callQwenAI(messageText, business, language, intent, settings);
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(aiResult.text));
        await incReply();
        await supabase.from("ai_logs").insert({ business_id: business.id, contact_phone: fromPhone, incoming_msg: messageText, ai_response: aiResult.text, kb_hit: false, model_used: "qwen", latency_ms: aiResult.latency, status: "success", confidence: 0.85 }).catch(()=>{});
        return;
      } catch (aiErr) {
        console.error("❌ AI failed:", aiErr.message);
        const fallback = settings.fallback_msg || `Thanks for your message! 😊 Type *MENU* for options or *CONTACT* to reach our team.`;
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(fallback));
        await incReply();
        await supabase.from("error_reports").insert({ business_id: business.id, error_type: "ai_timeout", context: { message: messageText }, message: aiErr.message }).catch(()=>{});
      }
    }

  } catch (err) {
    console.error("💥 Webhook error:", err.message);
  }
});

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================

app.post("/webhook/paystack", async (req, res) => {
  try {
    const sig  = req.headers["x-paystack-signature"];
    const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "").update(req.body).digest("hex");
    if (hash !== sig) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());
    console.log(`💳 Paystack: ${event.event}`);

    if (event.event === "charge.success") {
      const meta    = event.data.metadata;
      const orderId = meta?.order_id, bizId = meta?.business_id, phone = meta?.contact_phone;
      if (!orderId) return res.sendStatus(200);

      await supabase.from("orders").update({ paystack_status: "success", paystack_ref: event.data.reference, paid_at: new Date().toISOString(), status: "paid", updated_at: new Date().toISOString() }).eq("id", orderId);
      await supabase.from("payments").insert({ business_id: bizId, order_id: orderId, type: "order", amount: event.data.amount/100, currency: event.data.currency, paystack_ref: event.data.reference, paystack_txn_id: String(event.data.id), status: "success" }).catch(()=>{});

      // Auto-deliver digital products
      if (phone) {
        const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
        if (order?.delivery_type === "digital" && !order.digital_sent) {
          const { data: bizSettings } = await supabase.from("business_settings").select("*").eq("business_id", bizId).single();
          if (bizSettings) {
            let msg = `🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} paid!\n\n📥 *Your Product:*\n`;
            for (const item of (order.items || [])) {
              const { data: p } = await supabase.from("products").select("digital_link,digital_code").eq("id", item.product_id).single();
              if (p?.digital_link) msg += `🔗 Download: ${p.digital_link}\n`;
              if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
            }
            msg += `\nThank you! 🙏 Type *MENU* to shop again.`;
            const tok = bizSettings.wa_access_token || process.env.WA_ACCESS_TOKEN;
            await sendWhatsAppMessage(bizSettings.wa_phone_id, tok, phone, msg);
            await supabase.from("orders").update({ digital_sent: true, digital_sent_at: new Date().toISOString(), status: "delivered" }).eq("id", orderId);
          }
        }
        // Update contact spending
        if (order) {
          const { data: c } = await supabase.from("contacts").select("*").eq("business_id", bizId).eq("phone", phone).single();
          if (c) await supabase.from("contacts").update({ total_orders: c.total_orders+1, total_spent: Number(c.total_spent)+Number(order.total) }).eq("id", c.id).catch(()=>{});
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("💥 Paystack error:", err.message);
    res.sendStatus(500);
  }
});

// ============================================================
// SUBSCRIPTION / UPGRADE
// ============================================================

app.post("/api/subscribe", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    const prices = { starter: 4900, growth: 14900, pro: 29900 };
    if (!prices[plan]) return res.status(400).json({ error: "Invalid plan. Choose: starter, growth, or pro." });
    const response = await axios.post("https://api.paystack.co/transaction/initialize",
      { email: req.business.email, amount: prices[plan]*100, currency: "NGN",
        reference: `SUB-${req.business.id.substring(0,8)}-${Date.now()}`,
        metadata: { business_id: req.business.id, plan, type: "subscription", username: req.business.username },
        callback_url: `${process.env.FRONTEND_URL}/dashboard.html?upgraded=1` },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json({ success: true, paymentLink: response.data?.data?.authorization_url, plan, amount: `₦${prices[plan].toLocaleString()}/month` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GLOBAL KEYWORD LIBRARY API
// ============================================================

// GET /global-kb — Browse the global keyword library
app.get("/global-kb", async (req, res) => {
  try {
    const { category, language, industry, search } = req.query;
    let query = supabase
      .from("global_kb_library")
      .select("*")
      .eq("is_active", true)
      .order("uses", { ascending: false });

    if (category) query = query.eq("category", category);
    if (language) query = query.eq("language", language);
    if (industry && industry !== "all") query = query.in("industry", [industry, "all"]);
    if (search)   query = query.or(`keyword.ilike.%${search}%,answer.ilike.%${search}%`);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, keywords: data, total: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /global-kb/:id/copy — Subscriber copies a keyword to their KB
app.post("/global-kb/:id/copy", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;

    // Check KB limit
    const { count } = await supabase
      .from("knowledge_base")
      .select("id", { count: "exact", head: true })
      .eq("business_id", req.business.id);

    if ((count || 0) >= limits.kb_limit) {
      return res.status(403).json({
        error: `KB limit (${limits.kb_limit}) reached. Upgrade to add more.`,
        upgrade_url: `${process.env.FRONTEND_URL}/pricing.html`,
      });
    }

    // Get the global entry
    const { data: entry, error: entErr } = await supabase
      .from("global_kb_library")
      .select("*")
      .eq("id", req.params.id)
      .eq("is_active", true)
      .single();

    if (entErr || !entry) return res.status(404).json({ error: "Keyword not found." });

    // Check if subscriber already has this keyword
    const { data: existing } = await supabase
      .from("knowledge_base")
      .select("id")
      .eq("business_id", req.business.id)
      .ilike("keyword", entry.keyword)
      .single();

    if (existing) {
      return res.status(409).json({ error: "You already have a similar keyword in your KB." });
    }

    // Copy to subscriber's KB
    const { customAnswer } = req.body; // allow subscriber to customise answer before copying
    const { data: kbEntry, error: kbErr } = await supabase
      .from("knowledge_base")
      .insert({
        business_id: req.business.id,
        keyword:     entry.keyword,
        answer:      customAnswer || entry.answer,
        category:    entry.category,
        language:    entry.language,
        is_active:   true,
      })
      .select()
      .single();

    if (kbErr) throw kbErr;

    // Increment uses counter on global entry
    await supabase
      .from("global_kb_library")
      .update({ uses: entry.uses + 1 })
      .eq("id", req.params.id);

    res.json({ success: true, message: "✅ Keyword copied to your Knowledge Base!", entry: kbEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /global-kb/copy-all — Copy ALL relevant keywords for an industry to subscriber's KB
app.post("/global-kb/copy-all", requireAuth, async (req, res) => {
  try {
    const { industry, language } = req.body;
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;

    // Get current KB count
    const { count: currentCount } = await supabase
      .from("knowledge_base")
      .select("id", { count: "exact", head: true })
      .eq("business_id", req.business.id);

    const slotsLeft = limits.kb_limit - (currentCount || 0);
    if (slotsLeft <= 0) {
      return res.status(403).json({ error: `KB limit (${limits.kb_limit}) reached.` });
    }

    // Get matching global keywords
    let query = supabase
      .from("global_kb_library")
      .select("*")
      .eq("is_active", true)
      .order("uses", { ascending: false });

    if (industry && industry !== "all") query = query.in("industry", [industry, "all"]);
    if (language) query = query.eq("language", language);

    const { data: globals } = await query.limit(slotsLeft);
    if (!globals?.length) return res.json({ success: true, copied: 0, message: "No keywords found." });

    // Get subscriber's existing keywords to avoid duplicates
    const { data: existing } = await supabase
      .from("knowledge_base")
      .select("keyword")
      .eq("business_id", req.business.id);

    const existingKeywords = new Set((existing || []).map(e => e.keyword.toLowerCase()));

    const toInsert = globals
      .filter(g => !existingKeywords.has(g.keyword.toLowerCase()))
      .map(g => ({
        business_id: req.business.id,
        keyword:     g.keyword,
        answer:      g.answer,
        category:    g.category,
        language:    g.language,
        is_active:   true,
      }));

    if (!toInsert.length) {
      return res.json({ success: true, copied: 0, message: "All keywords already in your KB." });
    }

    const { data: inserted, error } = await supabase
      .from("knowledge_base")
      .insert(toInsert)
      .select();

    if (error) throw error;

    res.json({
      success: true,
      copied:  inserted?.length || 0,
      message: `✅ ${inserted?.length} keywords added to your Knowledge Base!`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /global-kb — Admin adds new global keyword
app.post("/global-kb", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required to add global keywords." });
    }

    const { keyword, answer, category, language, industry } = req.body;
    if (!keyword || !answer) return res.status(400).json({ error: "Keyword and answer required." });

    const { data, error } = await supabase
      .from("global_kb_library")
      .insert({
        keyword, answer,
        category:   category || "general",
        language:   language || "en",
        industry:   industry || "all",
        created_by: req.business.username,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, keyword: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /global-kb/:id — Admin edits global keyword
app.patch("/global-kb/:id", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { data, error } = await supabase
      .from("global_kb_library")
      .update({ ...req.body })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, keyword: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /global-kb/:id — Admin removes global keyword
app.delete("/global-kb/:id", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    await supabase.from("global_kb_library").update({ is_active: false }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN ROUTES (Founder-only endpoints)
// ============================================================

// GET /admin/all-businesses — list all subscribers
app.get("/admin/all-businesses", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { data, error } = await supabase
      .from("businesses")
      .select("id, username, business_name, plan, reply_count, reply_limit, created_at, is_active")
      .order("created_at", { ascending: false });
    if (error) throw error;

    // Get order counts
    const { data: orders } = await supabase.from("orders").select("business_id");
    const orderCounts = {};
    (orders || []).forEach(o => { orderCounts[o.business_id] = (orderCounts[o.business_id] || 0) + 1; });
    const enriched = (data || []).map(b => ({ ...b, total_orders: orderCounts[b.id] || 0 }));

    res.json({ success: true, businesses: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/platform-stats — overall platform metrics
app.get("/admin/platform-stats", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { count: bizCount  } = await supabase.from("businesses").select("id", { count: "exact", head: true });
    const { count: orderCount } = await supabase.from("orders").select("id", { count: "exact", head: true });
    const { data: revData }     = await supabase.from("orders").select("total").eq("paystack_status", "success");
    const totalRevenue = (revData || []).reduce((sum, o) => sum + Number(o.total || 0), 0);

    res.json({
      success: true,
      stats: {
        total_businesses: bizCount || 0,
        total_orders:     orderCount || 0,
        total_revenue:    totalRevenue,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/set-plan — switch plan for testing (admin only)
app.post("/admin/set-plan", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { plan, businessId } = req.body;
    if (!PLAN_LIMITS[plan]) return res.status(400).json({ error: "Invalid plan." });

    const targetId = businessId || req.business.id;
    await supabase.from("businesses").update({
      plan,
      reply_limit: PLAN_LIMITS[plan].reply_limit,
      updated_at:  new Date().toISOString(),
    }).eq("id", targetId);

    res.json({ success: true, message: `✅ Plan set to ${plan} for testing.`, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/test-message — send a test WhatsApp message (admin only)
app.post("/admin/test-message", requireAuth, async (req, res) => {
  try {
    const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "mubaz,zapitapps,admin").split(",").map(u => u.trim().toLowerCase());
    if (!ADMIN_USERNAMES.includes(req.business.username)) {
      return res.status(403).json({ error: "Admin access required." });
    }
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "Phone and message required." });

    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (!settings?.wa_phone_id) return res.status(400).json({ error: "WhatsApp not configured. Complete setup first." });

    const accessToken = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const result = await sendWhatsAppMessage(settings.wa_phone_id, accessToken, phone, message);

    if (result.success) {
      res.json({ success: true, messageId: result.messageId, message: "✅ Test message sent!" });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PAYMENT FLEXIBILITY MODULE
// Supports subscribers WITHOUT Paystack API keys
// Options: Manual bank transfer, OPay, PalmPay, Kuda, etc.
// ============================================================

// Payment methods configuration
const PAYMENT_METHODS = {
  paystack:     { name: "Paystack",      type: "api",    icon: "💳" },
  bank_transfer:{ name: "Bank Transfer", type: "manual", icon: "🏦" },
  opay:         { name: "OPay",          type: "manual", icon: "📱" },
  palmpay:      { name: "PalmPay",       type: "manual", icon: "📱" },
  kuda:         { name: "Kuda Bank",     type: "manual", icon: "🏦" },
  moniepoint:   { name: "Moniepoint",    type: "manual", icon: "💰" },
  cash:         { name: "Cash on Delivery", type: "manual", icon: "💵" },
  ussd:         { name: "USSD Transfer", type: "manual", icon: "📞" },
};

// GET /payment-methods — get available payment methods for a business
app.get("/payment-methods/:businessId", async (req, res) => {
  try {
    const { data: settings } = await supabase
      .from("business_settings")
      .select("paystack_secret, payment_methods, bank_details")
      .eq("business_id", req.params.businessId)
      .single();

    const methods = [];

    // Paystack available if they have API key
    if (settings?.paystack_secret) {
      methods.push({ id: "paystack", ...PAYMENT_METHODS.paystack, available: true });
    }

    // Manual methods — from their bank_details
    const bankDetails = settings?.bank_details || {};
    if (bankDetails.bank_name && bankDetails.account_number) {
      methods.push({ id: "bank_transfer", ...PAYMENT_METHODS.bank_transfer, available: true, details: bankDetails });
    }
    if (bankDetails.opay_number) {
      methods.push({ id: "opay", ...PAYMENT_METHODS.opay, available: true, details: { number: bankDetails.opay_number, name: bankDetails.account_name } });
    }
    if (bankDetails.palmpay_number) {
      methods.push({ id: "palmpay", ...PAYMENT_METHODS.palmpay, available: true, details: { number: bankDetails.palmpay_number, name: bankDetails.account_name } });
    }
    if (bankDetails.kuda_number) {
      methods.push({ id: "kuda", ...PAYMENT_METHODS.kuda, available: true, details: { number: bankDetails.kuda_number, name: bankDetails.account_name } });
    }
    if (bankDetails.moniepoint_number) {
      methods.push({ id: "moniepoint", ...PAYMENT_METHODS.moniepoint, available: true, details: { number: bankDetails.moniepoint_number, name: bankDetails.account_name } });
    }
    if (bankDetails.cash_on_delivery) {
      methods.push({ id: "cash", ...PAYMENT_METHODS.cash, available: true, details: { note: bankDetails.cod_note || "Payment collected on delivery" } });
    }

    res.json({ success: true, methods, hasPaystack: !!settings?.paystack_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/bank-details — subscriber saves their bank/payment details
app.patch("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const {
      bankName, accountNumber, accountName,
      opayNumber, palmpayNumber, kudaNumber,
      moniepointNumber, cashOnDelivery, codNote,
      ussdCode,
    } = req.body;

    const bankDetails = {};
    if (bankName)         bankDetails.bank_name          = bankName;
    if (accountNumber)    bankDetails.account_number     = accountNumber;
    if (accountName)      bankDetails.account_name       = accountName;
    if (opayNumber)       bankDetails.opay_number        = opayNumber;
    if (palmpayNumber)    bankDetails.palmpay_number     = palmpayNumber;
    if (kudaNumber)       bankDetails.kuda_number        = kudaNumber;
    if (moniepointNumber) bankDetails.moniepoint_number  = moniepointNumber;
    if (cashOnDelivery)   bankDetails.cash_on_delivery   = cashOnDelivery;
    if (codNote)          bankDetails.cod_note           = codNote;
    if (ussdCode)         bankDetails.ussd_code          = ussdCode;

    // Update business_settings — add bank_details column
    const { data, error } = await supabase
      .from("business_settings")
      .update({ bank_details: bankDetails, updated_at: new Date().toISOString() })
      .eq("business_id", req.business.id)
      .select().single();

    if (error) throw error;
    res.json({ success: true, message: "✅ Payment details saved! Customers can now pay via your bank details.", bankDetails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/bank-details — get current payment details
app.get("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("business_settings")
      .select("bank_details, paystack_public, paystack_secret")
      .eq("business_id", req.business.id)
      .single();
    if (error) throw error;
    // Mask paystack secret
    const hasPaystack = !!(data?.paystack_secret);
    res.json({ success: true, bankDetails: data?.bank_details || {}, hasPaystack, paystackPublic: data?.paystack_public || "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders/:id/confirm-manual — Admin confirms a manual payment (bank/OPay etc)
app.post("/dashboard/orders/:id/confirm-payment", requireAuth, async (req, res) => {
  try {
    const { paymentMethod, reference, amountReceived, note } = req.body;

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .single();

    if (!order) return res.status(404).json({ error: "Order not found." });

    // Update order as paid
    await supabase.from("orders").update({
      status:          "paid",
      paystack_status: "success",
      paystack_ref:    reference || `MANUAL-${Date.now()}`,
      paid_at:         new Date().toISOString(),
      payment_method:  paymentMethod || "manual",
      notes:           note || `Manual payment confirmed via ${paymentMethod}`,
      updated_at:      new Date().toISOString(),
    }).eq("id", req.params.id);

    // Log payment
    await supabase.from("payments").insert({
      business_id:    req.business.id,
      order_id:       req.params.id,
      type:           "order",
      amount:         amountReceived || order.total,
      currency:       order.currency,
      paystack_ref:   reference || `MANUAL-${Date.now()}`,
      status:         "success",
      plan:           paymentMethod || "manual",
    }).catch(() => {});

    // Deliver digital product if applicable
    if (order.delivery_type === "digital" && !order.digital_sent) {
      const { data: settings } = await supabase
        .from("business_settings").select("*").eq("business_id", req.business.id).single();
      if (settings?.wa_phone_id) {
        const { data: contact } = await supabase
          .from("contacts").select("phone").eq("id", order.contact_id).single();
        if (contact) {
          let msg = `🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} — Payment received!\n\n📥 *Your Product:*\n`;
          for (const item of (order.items || [])) {
            const { data: p } = await supabase.from("products").select("digital_link,digital_code").eq("id", item.product_id).single();
            if (p?.digital_link) msg += `🔗 Download: ${p.digital_link}\n`;
            if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
          }
          msg += `\nThank you! 🙏 Type MENU to shop again.`;
          const tok = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;
          await sendWhatsAppMessage(settings.wa_phone_id, tok, contact.phone, msg);
          await supabase.from("orders").update({ digital_sent: true, digital_sent_at: new Date().toISOString(), status: "delivered" }).eq("id", req.params.id);
        }
      }
    }

    res.json({ success: true, message: "✅ Payment confirmed! Order updated to paid." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHARED NUMBER ROUTING SYSTEM
// All subscribers share YOUR one WhatsApp number
// Customers type @username to connect to a business
// ============================================================

// In-memory session store (customer → business mapping)
const sharedSessions = new Map();
const SESSION_TIMEOUT = 60 * 60 * 1000; // 60 minutes

// GET /shared/directory — public business directory
app.get("/shared/directory", async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = supabase
      .from("businesses")
      .select("id, username, business_name, business_category, business_desc, city")
      .eq("is_active", true)
      .not("business_name", "is", null);
    if (category) query = query.eq("business_category", category);
    if (search)   query = query.ilike("business_name", `%${search}%`);
    const { data } = await query.order("referral_count", { ascending: false }).limit(50);
    res.json({
      success: true,
      businesses: data || [],
      sharedNumber: process.env.SHARED_WA_NUMBER || "",
      instructions: "Customers message this number and type @username to connect to any business",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /shared/qr/:username — QR code for a business
app.get("/shared/qr/:username", async (req, res) => {
  try {
    const { data: biz } = await supabase
      .from("businesses")
      .select("username, business_name")
      .eq("username", req.params.username.toLowerCase())
      .single();
    if (!biz) return res.status(404).json({ error: "Business not found." });
    const sharedNumber = (process.env.SHARED_WA_NUMBER || "").replace(/\D/g, "");
    const waLink = `https://wa.me/${sharedNumber}?text=@${biz.username}`;
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(waLink)}`;
    res.json({
      success: true, business: biz.business_name,
      shortcode: `@${biz.username}`, waLink, qrCodeUrl: qrUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GLOBAL KEYWORD LIBRARY API
// ============================================================

app.get("/global-kb", async (req, res) => {
  try {
    const { category, language, industry, search } = req.query;
    let query = supabase.from("global_kb_library").select("*").eq("is_active", true).order("uses", { ascending: false });
    if (category) query = query.eq("category", category);
    if (language) query = query.eq("language", language);
    if (industry && industry !== "all") query = query.in("industry", [industry, "all"]);
    if (search)   query = query.or(`keyword.ilike.%${search}%,answer.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, keywords: data, total: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/global-kb/:id/copy", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    if ((count || 0) >= limits.kb_limit) return res.status(403).json({ error: `KB limit (${limits.kb_limit}) reached. Upgrade to add more.` });

    const { data: entry } = await supabase.from("global_kb_library").select("*").eq("id", req.params.id).eq("is_active", true).single();
    if (!entry) return res.status(404).json({ error: "Keyword not found." });

    const { data: existing } = await supabase.from("knowledge_base").select("id").eq("business_id", req.business.id).ilike("keyword", entry.keyword).single();
    if (existing) return res.status(409).json({ error: "You already have a similar keyword in your KB." });

    const { customAnswer } = req.body;
    const { data: kbEntry, error } = await supabase.from("knowledge_base").insert({
      business_id: req.business.id, keyword: entry.keyword,
      answer: customAnswer || entry.answer, category: entry.category,
      language: entry.language, is_active: true,
    }).select().single();
    if (error) throw error;

    await supabase.from("global_kb_library").update({ uses: entry.uses + 1 }).eq("id", req.params.id);
    res.json({ success: true, message: "✅ Keyword copied to your KB!", entry: kbEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/global-kb/copy-all", requireAuth, async (req, res) => {
  try {
    const { industry, language } = req.body;
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count: currentCount } = await supabase.from("knowledge_base").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    const slotsLeft = limits.kb_limit - (currentCount || 0);
    if (slotsLeft <= 0) return res.status(403).json({ error: `KB limit reached.` });

    let query = supabase.from("global_kb_library").select("*").eq("is_active", true).order("uses", { ascending: false });
    if (industry && industry !== "all") query = query.in("industry", [industry, "all"]);
    if (language) query = query.eq("language", language);
    const { data: globals } = await query.limit(slotsLeft);
    if (!globals?.length) return res.json({ success: true, copied: 0 });

    const { data: existing } = await supabase.from("knowledge_base").select("keyword").eq("business_id", req.business.id);
    const existingKw = new Set((existing || []).map(e => e.keyword.toLowerCase()));

    const toInsert = globals.filter(g => !existingKw.has(g.keyword.toLowerCase())).map(g => ({
      business_id: req.business.id, keyword: g.keyword, answer: g.answer,
      category: g.category, language: g.language, is_active: true,
    }));

    if (!toInsert.length) return res.json({ success: true, copied: 0, message: "All keywords already in your KB." });
    const { data: inserted, error } = await supabase.from("knowledge_base").insert(toInsert).select();
    if (error) throw error;
    res.json({ success: true, copied: inserted?.length || 0, message: `✅ ${inserted?.length} keywords added to your KB!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/global-kb", requireAuth, async (req, res) => {
  try {
    const ADMINS = (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase());
    if (!ADMINS.includes(req.business.username)) return res.status(403).json({ error: "Admin only." });
    const { keyword, answer, category, language, industry } = req.body;
    if (!keyword || !answer) return res.status(400).json({ error: "Keyword and answer required." });
    const { data, error } = await supabase.from("global_kb_library").insert({ keyword, answer, category: category || "general", language: language || "en", industry: industry || "all", created_by: req.business.username }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, keyword: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================

app.get("/admin/all-businesses", requireAuth, async (req, res) => {
  try {
    const ADMINS = (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase());
    if (!ADMINS.includes(req.business.username)) return res.status(403).json({ error: "Admin only." });
    const { data, error } = await supabase.from("businesses").select("id, username, business_name, plan, reply_count, reply_limit, created_at, is_active").order("created_at", { ascending: false });
    if (error) throw error;
    const { data: orders } = await supabase.from("orders").select("business_id");
    const orderCounts = {};
    (orders || []).forEach(o => { orderCounts[o.business_id] = (orderCounts[o.business_id] || 0) + 1; });
    res.json({ success: true, businesses: (data || []).map(b => ({ ...b, total_orders: orderCounts[b.id] || 0 })), total: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/platform-stats", requireAuth, async (req, res) => {
  try {
    const ADMINS = (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase());
    if (!ADMINS.includes(req.business.username)) return res.status(403).json({ error: "Admin only." });
    const { count: bizCount }   = await supabase.from("businesses").select("id", { count: "exact", head: true });
    const { count: orderCount } = await supabase.from("orders").select("id", { count: "exact", head: true });
    const { data: revData }     = await supabase.from("orders").select("total").eq("paystack_status", "success");
    const totalRevenue = (revData || []).reduce((sum, o) => sum + Number(o.total || 0), 0);
    res.json({ success: true, stats: { total_businesses: bizCount || 0, total_orders: orderCount || 0, total_revenue: totalRevenue } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/set-plan", requireAuth, async (req, res) => {
  try {
    const ADMINS = (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase());
    if (!ADMINS.includes(req.business.username)) return res.status(403).json({ error: "Admin only." });
    const { plan, businessId } = req.body;
    if (!PLAN_LIMITS[plan]) return res.status(400).json({ error: "Invalid plan." });
    await supabase.from("businesses").update({ plan, reply_limit: PLAN_LIMITS[plan].reply_limit, updated_at: new Date().toISOString() }).eq("id", businessId || req.business.id);
    res.json({ success: true, message: `✅ Plan set to ${plan}`, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/test-message", requireAuth, async (req, res) => {
  try {
    const ADMINS = (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase());
    if (!ADMINS.includes(req.business.username)) return res.status(403).json({ error: "Admin only." });
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "Phone and message required." });
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (!settings?.wa_phone_id) return res.status(400).json({ error: "WhatsApp not configured." });
    const result = await sendWhatsAppMessage(settings.wa_phone_id, settings.wa_access_token || process.env.WA_ACCESS_TOKEN, phone, message);
    res.json(result.success ? { success: true, messageId: result.messageId } : { success: false, error: result.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HEALTH CHECK & ROOT
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status:   "✅ VendrAI v3.0 is running",
    version:  "3.0.0",
    timestamp: new Date().toISOString(),
    uptime:   Math.floor(process.uptime()),
    env:      process.env.NODE_ENV || "production",
    features: ["multi-tenant","auth","onboarding","excel-import","message-queue","100-business-templates","self-healing-ai"],
    queue:    msgQueue.stats,
  });
});

app.get("/", (req, res) => {
  res.json({ app: "VendrAI", version: "3.0.0", status: "🟢 Live", tagline: "AI WhatsApp Automation for African SMEs" });
});

app.use((req, res) => res.status(404).json({ error: "Route not found", path: req.path }));
app.use((err, req, res, next) => { console.error("💥", err.message); res.status(500).json({ error: "Internal server error" }); });

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 VendrAI v3.0 running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`💬 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`⚡ Queue: 60 msg/sec rate limiting active`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "production"}\n`);
});

module.exports = app;
