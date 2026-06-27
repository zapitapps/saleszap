// ============================================================
// VendrAI Backend — index.js FINAL COMPLETE v3.1
// ALL FEATURES INCLUDED. NO DUPLICATES. UPLOAD THIS FILE.
// Features: Auth + OTP Email + Shared Number + Admin Panel +
//           Product Edit + Payment Flex (Bank/OPay/PalmPay) +
//           Global KB + Templates + AI + Queue + Paystack
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
  free:    { reply_limit:100,    product_limit:5,    contact_limit:100,   broadcast_limit:0,    kb_limit:20,   ai_enabled:true, broadcasts_enabled:false, analytics:false, excel_import:false, remove_watermark:false },
  starter: { reply_limit:500,    product_limit:20,   contact_limit:500,   broadcast_limit:100,  kb_limit:100,  ai_enabled:true, broadcasts_enabled:true,  analytics:false, excel_import:false, remove_watermark:true  },
  growth:  { reply_limit:3000,   product_limit:100,  contact_limit:5000,  broadcast_limit:500,  kb_limit:500,  ai_enabled:true, broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
  pro:     { reply_limit:999999, product_limit:9999, contact_limit:99999, broadcast_limit:9999, kb_limit:9999, ai_enabled:true, broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
};

const PLAN_PRICES_NGN = { starter: 4900, growth: 14900, pro: 29900 };

const WATERMARK = "\n\n_Powered by VendrAI_ 🤖 | vendrai.app";
const HF_MODEL  = "Qwen/Qwen2.5-72B-Instruct";
const HF_API    = "https://router.huggingface.co/v1/chat/completions";

// ============================================================
// MESSAGE QUEUE (60 msg/sec — respects WhatsApp 80 MPS limit)
// ============================================================
class MessageQueue {
  constructor() {
    this.queues     = new Map();
    this.processing = new Map();
    this.DELAY_MS   = Math.ceil(1000 / 60);
    this.stats      = { sent: 0, failed: 0, queued: 0 };
  }
  add(bizId, phoneId, token, to, msg) {
    if (!this.queues.has(bizId)) this.queues.set(bizId, []);
    this.queues.get(bizId).push({ phoneId, token, to, msg });
    this.stats.queued++;
    if (!this.processing.get(bizId)) this.processQueue(bizId);
  }
  async processQueue(bizId) {
    this.processing.set(bizId, true);
    const q = this.queues.get(bizId);
    while (q && q.length > 0) {
      const j = q.shift();
      try { await sendWA(j.phoneId, j.token, j.to, j.msg); this.stats.sent++; }
      catch(e) { this.stats.failed++; }
      await sleep(this.DELAY_MS);
    }
    this.processing.set(bizId, false);
  }
  status(bizId) { return { pending: this.queues.get(bizId)?.length||0, processing: this.processing.get(bizId)||false, stats: this.stats }; }
}
const msgQueue = new MessageQueue();

// Shared number sessions (customer → business routing)
const sharedSessions = new Map();
const SESSION_MS     = 60 * 60 * 1000;

// ============================================================
// UTILITIES
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hashPw(pw) {
  return crypto.createHash("sha256").update(pw + (process.env.ADMIN_SECRET_TOKEN || "vendrai")).digest("hex");
}
function genOTP()   { return Math.floor(100000 + Math.random() * 900000).toString(); }
function genToken() { return crypto.randomBytes(32).toString("hex"); }
function genRef()   { return "VND-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }

function getAdmins() {
  return (process.env.ADMIN_USERNAMES || "").split(",").map(u => u.trim().toLowerCase()).filter(Boolean);
}

function detectLang(text) {
  const t = text.toLowerCase();
  if (/\b(abeg|wahala|oga|wetin|dey|sabi)\b/i.test(t)) return "pidgin";
  if (/\b(ẹ|ọ|ṣe|bawo|elo ni)\b/i.test(t)) return "yo";
  if (/\b(ndewo|nnọọ|biko)\b/i.test(t)) return "ig";
  if (/\b(sannu|nawa ne|aboki)\b/i.test(t)) return "ha";
  return "en";
}

function detectIntent(text) {
  const t = text.toLowerCase();
  if (/\b(hi|hello|hey|good morning|howdy)\b/i.test(t)) return "greeting";
  if (/\b(order|buy|purchase|i want|i need)\b/i.test(t)) return "order";
  if (/\b(price|how much|cost|rate|naira)\b/i.test(t)) return "price";
  if (/\b(track|status|where is|my order)\b/i.test(t)) return "track";
  if (/\b(pay|payment|bank|transfer|card)\b/i.test(t)) return "payment";
  if (/\b(deliver|ship|shipping|how long)\b/i.test(t)) return "delivery";
  if (/\b(contact|phone|call|human|agent)\b/i.test(t)) return "contact";
  if (/\b(catalog|product|shop|browse|list)\b/i.test(t)) return "product";
  if (/\b(cancel|return|refund)\b/i.test(t)) return "cancel";
  return "general";
}

function fuzzy(text, kw) {
  const tw = text.toLowerCase().split(/\s+/);
  const kws = kw.toLowerCase().split(/\s+/);
  return kws.filter(k => tw.some(t => t.includes(k)||k.includes(t))).length / kws.length;
}

// ============================================================
// OTP EMAIL — Brevo (free 300/day) + WhatsApp fallback
// ============================================================
async function sendOTPEmail(email, otp, type = "email_verify") {
  console.log(`📧 OTP for ${email}: ${otp} [${type}]`);

  const BREVO = process.env.BREVO_API_KEY;
  if (!BREVO) {
    console.warn("⚠️ BREVO_API_KEY not set — OTP only in logs");
    return false;
  }

  const subjects = {
    email_verify:   `VendrAI — Your verification code: ${otp}`,
    password_reset: `VendrAI — Reset your password: ${otp}`,
  };

  const html = `<div style="font-family:Arial,sans-serif;background:#0B0F1A;color:#E2E8F0;padding:30px;border-radius:16px;max-width:480px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:20px;">
      <div style="background:linear-gradient(135deg,#25D366,#128C7E);width:48px;height:48px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;">🤖</div>
      <h2 style="color:#25D366;margin:8px 0 4px;">VendrAI</h2>
      <p style="color:#64748B;font-size:.82rem;margin:0;">AI WhatsApp Automation for African SMEs</p>
    </div>
    <h3 style="text-align:center;font-size:1rem;">${type === "password_reset" ? "Reset Your Password" : "Verify Your Email"}</h3>
    <p style="color:#94A3B8;text-align:center;font-size:.85rem;">Your one-time code is:</p>
    <div style="background:#111827;border:2px solid rgba(37,211,102,.3);border-radius:12px;padding:18px;text-align:center;margin:16px 0;">
      <div style="font-size:2.2rem;font-weight:900;letter-spacing:.3em;color:#25D366;">${otp}</div>
      <div style="color:#64748B;font-size:.75rem;margin-top:6px;">Expires in 10 minutes</div>
    </div>
    <p style="color:#64748B;font-size:.75rem;text-align:center;">If you did not request this, please ignore.</p>
  </div>`;

  try {
    await axios.post("https://api.brevo.com/v3/smtp/email", {
      sender:      { name: "VendrAI", email: process.env.BREVO_SENDER_EMAIL || "noreply@vendrai.app" },
      to:          [{ email }],
      subject:     subjects[type] || `VendrAI Code: ${otp}`,
      htmlContent: html,
    }, {
      headers: { "api-key": BREVO, "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log(`✅ Email sent to ${email} via Brevo`);
    return true;
  } catch(err) {
    console.error("❌ Brevo failed:", err.response?.data?.message || err.message);
    return false;
  }
}

async function sendOTPWhatsApp(phone, otp, type = "email_verify") {
  const phoneId = process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token || !/^\+[1-9]\d{7,14}$/.test(phone)) return false;
  const msgs = {
    email_verify:   `🤖 *VendrAI Verification*\n\nYour verification code:\n\n*${otp}*\n\nExpires in 10 minutes. Do not share.`,
    password_reset: `🔑 *VendrAI Password Reset*\n\nYour reset code:\n\n*${otp}*\n\nExpires in 10 minutes.`,
  };
  try {
    await sendWA(phoneId, token, phone, msgs[type] || msgs.email_verify);
    console.log(`✅ WhatsApp OTP sent to ${phone}`);
    return true;
  } catch(err) {
    console.error("❌ WA OTP failed:", err.message);
    return false;
  }
}

// ============================================================
// WHATSAPP SENDER
// ============================================================
async function sendWA(phoneId, token, to, message) {
  try {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
    return { success: true, messageId: r.data?.messages?.[0]?.id };
  } catch(err) {
    console.error("❌ WA send error:", err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Notify a subscriber on their phone
async function notifySubscriber(businessId, message) {
  try {
    const { data: biz } = await supabase.from("businesses").select("phone,contact_phone").eq("id", businessId).single();
    const phone = biz?.contact_phone || biz?.phone;
    if (!phone) return;
    const phoneId = process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
    const token   = process.env.WA_ACCESS_TOKEN;
    if (phoneId && token) await sendWA(phoneId, token, phone, message);
  } catch(e) {}
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Not logged in. Please log in first." });
  const { data: session } = await supabase.from("sessions").select("*, businesses(*)")
    .eq("session_token", token).eq("is_active", true).gt("expires_at", new Date().toISOString()).single();
  if (!session) return res.status(401).json({ error: "Session expired. Please log in again." });
  await supabase.from("sessions").update({ last_used_at: new Date().toISOString() }).eq("id", session.id);
  req.business = session.businesses;
  req.session  = session;
  next();
}

function requirePlan(feature) {
  return (req, res, next) => {
    const limits = PLAN_LIMITS[req.business?.plan] || PLAN_LIMITS.free;
    if (!limits[feature]) return res.status(403).json({
      error: `This feature requires a higher plan.`,
      current_plan: req.business?.plan,
      upgrade_url: `${process.env.FRONTEND_URL}/pricing.html`,
    });
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
    if (!username||!email||!phone||!password||!businessName)
      return res.status(400).json({ error: "All fields required: username, email, phone, password, businessName" });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
      return res.status(400).json({ error: "Username: 3-30 chars, letters/numbers/underscores only." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (!/^\+[1-9]\d{7,14}$/.test(phone))
      return res.status(400).json({ error: "Phone must include country code e.g. +2348012345678" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    const { data: eu } = await supabase.from("businesses").select("id").eq("username", username.toLowerCase()).single();
    if (eu) return res.status(409).json({ error: "Username already taken." });
    const { data: ee } = await supabase.from("businesses").select("id").eq("email", email.toLowerCase()).single();
    if (ee) return res.status(409).json({ error: "Email already registered. Try logging in." });
    const { data: ep } = await supabase.from("businesses").select("id").eq("phone", phone).single();
    if (ep) return res.status(409).json({ error: "Phone number already registered." });

    let referrerId = null;
    if (referralCode) {
      const { data: ref } = await supabase.from("businesses").select("id").eq("referral_code", referralCode).single();
      if (ref) referrerId = ref.id;
    }

    const { data: biz, error: bizErr } = await supabase.from("businesses").insert({
      username: username.toLowerCase(), email: email.toLowerCase(),
      phone, password_hash: hashPw(password),
      business_name: businessName, whatsapp_number: phone,
      referral_code: genRef(), referred_by: referrerId,
      plan: "free", reply_limit: 100,
    }).select().single();
    if (bizErr) throw bizErr;

    await supabase.from("business_settings").insert({ business_id: biz.id, wa_verify_token: genToken().substring(0,20) });
    await supabase.from("subscriptions").insert({ business_id: biz.id, plan: "free", status: "trial" });

    const { data: templates } = await supabase.from("default_kb_templates").select("*");
    if (templates?.length) {
      await supabase.from("knowledge_base").insert(
        templates.map(t => ({ business_id: biz.id, keyword: t.keyword, answer: t.answer, category: t.category, language: t.language }))
      );
    }

    if (referrerId) {
      await supabase.from("referrals").insert({ referrer_id: referrerId, referred_id: biz.id, referral_code: referralCode, status: "signed_up" });
      const { data: refBiz } = await supabase.from("businesses").select("referral_count").eq("id", referrerId).single();
      await supabase.from("businesses").update({ referral_count: (refBiz?.referral_count||0)+1 }).eq("id", referrerId);
    }

    // Send OTP via email, fallback to WhatsApp
    const otp = genOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "email_verify", otp_code: otp });
    const emailSent = await sendOTPEmail(email.toLowerCase(), otp, "email_verify");
    if (!emailSent) await sendOTPWhatsApp(phone, otp, "email_verify");

    const sessionToken = genToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });

    res.status(201).json({
      success: true,
      message: emailSent
        ? "✅ Account created! Check your email for verification code."
        : "✅ Account created! Check your WhatsApp for verification code.",
      session_token: sessionToken,
      otp_delivery: emailSent ? "email" : "whatsapp",
      business: { id: biz.id, username: biz.username, businessName: biz.business_name, email: biz.email, phone: biz.phone, plan: "free", referralCode: biz.referral_code },
    });
  } catch(err) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// POST /auth/login
app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier||!password) return res.status(400).json({ error: "Username/email and password required." });
    const { data: biz } = await supabase.from("businesses").select("*")
      .or(`username.eq.${identifier.toLowerCase()},email.eq.${identifier.toLowerCase()}`).single();
    if (!biz) return res.status(401).json({ error: "No account found with that username or email." });
    if (biz.password_hash !== hashPw(password)) return res.status(401).json({ error: "Incorrect password." });
    if (biz.is_suspended) return res.status(403).json({ error: `Account suspended: ${biz.suspension_reason||"Contact support."}` });
    const sessionToken = genToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });
    await supabase.from("businesses").update({ last_login_at: new Date().toISOString() }).eq("id", biz.id);
    res.json({
      success: true, message: "✅ Login successful!", session_token: sessionToken,
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
  } catch(err) { res.status(500).json({ error: "Login failed. Please try again." }); }
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
    if (record.otp_code !== otp) {
      await supabase.from("otp_verifications").update({ attempts: (record.attempts||0)+1 }).eq("id", record.id);
      return res.status(400).json({ error: "Incorrect OTP. Please try again." });
    }
    await supabase.from("businesses").update({ email_verified: true }).eq("id", req.business.id);
    await supabase.from("otp_verifications").update({ used: true }).eq("id", record.id);
    res.json({ success: true, message: "✅ Email verified! Your account is fully active." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /auth/resend-otp
app.post("/auth/resend-otp", requireAuth, async (req, res) => {
  try {
    const otp = genOTP();
    await supabase.from("otp_verifications").insert({ identifier: req.business.email, type: "email_verify", otp_code: otp });
    const emailSent = await sendOTPEmail(req.business.email, otp, "email_verify");
    if (!emailSent) await sendOTPWhatsApp(req.business.phone, otp, "email_verify");
    res.json({ success: true, message: emailSent ? "✅ Code sent to your email!" : "✅ Code sent to your WhatsApp!" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /auth/forgot-password
app.post("/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });
    const { data: biz } = await supabase.from("businesses").select("id,phone").eq("email", email.toLowerCase()).single();
    if (!biz) return res.status(404).json({ error: "No account found with that email." });
    const otp = genOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "password_reset", otp_code: otp });
    const emailSent = await sendOTPEmail(email.toLowerCase(), otp, "password_reset");
    if (!emailSent && biz.phone) await sendOTPWhatsApp(biz.phone, otp, "password_reset");
    res.json({ success: true, message: "✅ Reset code sent to your email." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /auth/reset-password
app.post("/auth/reset-password", authLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email||!otp||!newPassword) return res.status(400).json({ error: "Email, OTP and new password required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const { data: record } = await supabase.from("otp_verifications").select("*")
      .eq("identifier", email.toLowerCase()).eq("type", "password_reset").eq("used", false)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).single();
    if (!record||record.otp_code!==otp) return res.status(400).json({ error: "Invalid or expired reset code." });
    await supabase.from("businesses").update({ password_hash: hashPw(newPassword) }).eq("email", email.toLowerCase());
    await supabase.from("otp_verifications").update({ used: true }).eq("id", record.id);
    res.json({ success: true, message: "✅ Password reset! Please log in with your new password." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /auth/me
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const biz = req.business;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", biz.id).single();
    const { data: stats }    = await supabase.from("business_dashboard").select("*").eq("id", biz.id).single();
    if (settings?.wa_access_token) settings.wa_access_token = settings.wa_access_token.substring(0,20)+"...";
    if (settings?.paystack_secret) settings.paystack_secret = "sk_***hidden***";
    res.json({ success: true, business: { ...biz, settings, stats, planLimits: PLAN_LIMITS[biz.plan]||PLAN_LIMITS.free } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /auth/change-password
app.patch("/auth/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword||!newPassword) return res.status(400).json({ error: "Both passwords required." });
    if (newPassword.length<8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    if (req.business.password_hash!==hashPw(currentPassword)) return res.status(401).json({ error: "Current password is incorrect." });
    await supabase.from("businesses").update({ password_hash: hashPw(newPassword) }).eq("id", req.business.id);
    await supabase.from("sessions").update({ is_active: false }).eq("business_id", req.business.id).neq("id", req.session.id);
    res.json({ success: true, message: "✅ Password changed! Other sessions logged out." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ONBOARDING
// ============================================================

app.post("/onboarding/business-info", requireAuth, async (req, res) => {
  try {
    const { businessName,businessDesc,businessCategory,contactPhone,contactEmail,address,city,state,country,deliveryAreas,deliveryFee,deliveryDays,freeDeliveryAbove } = req.body;
    if (!businessName) return res.status(400).json({ error: "Business name is required." });
    await supabase.from("businesses").update({
      business_name:businessName,business_desc:businessDesc||null,business_category:businessCategory||"general",
      contact_phone:contactPhone||null,contact_email:contactEmail||null,address:address||null,
      city:city||null,state:state||null,country:country||"Nigeria",
      delivery_areas:deliveryAreas||[],delivery_fee:parseFloat(deliveryFee)||0,
      delivery_days:deliveryDays||"1-3 business days",
      free_delivery_above:freeDeliveryAbove?parseFloat(freeDeliveryAbove):null,
      updated_at:new Date().toISOString(),
    }).eq("id", req.business.id);
    res.json({ success: true, message: "✅ Business info saved!" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/onboarding/whatsapp", requireAuth, async (req, res) => {
  try {
    const { waPhoneId,waAccessToken,waBusinessId,paystackPublic,paystackSecret } = req.body;
    if (!waPhoneId||!waAccessToken) return res.status(400).json({ error: "WhatsApp Phone ID and Access Token required." });
    await supabase.from("business_settings").update({
      wa_phone_id:waPhoneId,wa_access_token:waAccessToken,wa_business_id:waBusinessId||null,
      paystack_public:paystackPublic||null,paystack_secret:paystackSecret||null,
      updated_at:new Date().toISOString(),
    }).eq("business_id", req.business.id);
    res.json({ success: true, message: "✅ WhatsApp connected!" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/onboarding/bot-messages", requireAuth, async (req, res) => {
  try {
    const { greetingMsg,fallbackMsg,awayMsg,aiPersonality,customInstructions,businessHoursStart,businessHoursEnd } = req.body;
    await supabase.from("business_settings").update({
      greeting_msg:greetingMsg||null,fallback_msg:fallbackMsg||null,away_msg:awayMsg||null,
      ai_personality:aiPersonality||"friendly",custom_instructions:customInstructions||null,
      business_hours_start:businessHoursStart||"08:00",business_hours_end:businessHoursEnd||"20:00",
      updated_at:new Date().toISOString(),
    }).eq("business_id", req.business.id);
    res.json({ success: true, message: "✅ Bot messages saved!" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/onboarding/apply-template", requireAuth, async (req, res) => {
  try {
    const { templateCode } = req.body;
    if (!templateCode) return res.status(400).json({ error: "templateCode is required." });
    const { data: tpl } = await supabase.from("business_type_templates").select("*").eq("code", templateCode).eq("is_active", true).single();
    if (!tpl) return res.status(404).json({ error: "Template not found." });
    const bizId  = req.business.id;
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;

    // Products
    const { data: tplProds } = await supabase.from("template_products").select("*").eq("template_id", tpl.id).order("sort_order");
    let prodsAdded = 0;
    if (tplProds?.length) {
      const { count } = await supabase.from("products").select("id",{count:"exact",head:true}).eq("business_id", bizId);
      const canAdd = limits.product_limit - (count||0);
      const toAdd  = tplProds.slice(0, canAdd);
      if (toAdd.length>0) {
        await supabase.from("products").insert(toAdd.map(p=>({
          business_id:bizId,name:p.name,description:p.description,price:p.price,sale_price:p.sale_price||null,
          currency:p.currency||"NGN",type:p.type||"physical",category:p.category||"general",stock:p.stock||null,
          digital_link:p.digital_link||null,keywords:p.keywords||[],tags:p.tags||[],is_active:true,imported_from:"template",
        })));
        prodsAdded = toAdd.length;
      }
    }

    // KB
    const { data: tplKB } = await supabase.from("template_kb").select("*").eq("template_id", tpl.id).order("sort_order");
    let kbAdded = 0;
    if (tplKB?.length) {
      await supabase.from("knowledge_base").delete().eq("business_id", bizId).eq("promoted_from_ai", false);
      const toAddKB = tplKB.slice(0, limits.kb_limit);
      await supabase.from("knowledge_base").insert(toAddKB.map(k=>({
        business_id:bizId,keyword:k.keyword,answer:k.answer,category:k.category||"general",language:k.language||"en",is_active:true,
      })));
      kbAdded = toAddKB.length;
    }

    // Settings
    const { data: tplSettings } = await supabase.from("template_settings").select("*").eq("template_id", tpl.id).single();
    if (tplSettings) {
      await supabase.from("business_settings").update({
        greeting_msg:tplSettings.greeting_msg||null,fallback_msg:tplSettings.fallback_msg||null,
        away_msg:tplSettings.away_msg||null,ai_personality:tplSettings.ai_personality||"friendly",
        custom_instructions:tplSettings.custom_instructions||null,updated_at:new Date().toISOString(),
      }).eq("business_id", bizId);
      if (tplSettings.delivery_areas?.length||tplSettings.delivery_fee) {
        await supabase.from("businesses").update({
          delivery_areas:tplSettings.delivery_areas||[],delivery_fee:tplSettings.delivery_fee||0,
          delivery_days:tplSettings.delivery_days||"1-3 business days",business_category:tpl.category,
          updated_at:new Date().toISOString(),
        }).eq("id", bizId);
      }
    }

    // Auto-load global KB for this industry
    const { data: globalKB } = await supabase.from("global_kb_library").select("*")
      .eq("is_active", true).in("industry", [tpl.category, "all"]).limit(limits.kb_limit - kbAdded);
    if (globalKB?.length) {
      const { data: existingKB } = await supabase.from("knowledge_base").select("keyword").eq("business_id", bizId);
      const existingKws = new Set((existingKB||[]).map(e=>e.keyword.toLowerCase()));
      const toAddGlobal = globalKB.filter(g=>!existingKws.has(g.keyword.toLowerCase())).map(g=>({
        business_id:bizId,keyword:g.keyword,answer:g.answer,category:g.category,language:g.language,is_active:true,
      }));
      if (toAddGlobal.length>0) await supabase.from("knowledge_base").insert(toAddGlobal);
      kbAdded += toAddGlobal.length;
    }

    await supabase.from("businesses").update({ template_code:templateCode,template_applied:true,updated_at:new Date().toISOString() }).eq("id", bizId);
    res.json({ success:true, message:`✅ "${tpl.name}" template applied!`, productsAdded:prodsAdded, kbEntriesAdded:kbAdded });
  } catch(err) {
    console.error("Apply template error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/onboarding/status", requireAuth, async (req, res) => {
  try {
    const biz = req.business;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", biz.id).single();
    const { data: products }  = await supabase.from("products").select("id").eq("business_id", biz.id).limit(1);
    const steps = {
      account_created:    true,
      email_verified:     biz.email_verified,
      business_info:      !!(biz.business_desc&&biz.city),
      whatsapp_connected: !!(settings?.wa_phone_id&&settings?.wa_access_token),
      products_added:     (products?.length||0) > 0,
      bot_customized:     biz.template_applied||false,
    };
    const completed = Object.values(steps).filter(Boolean).length;
    const total     = Object.keys(steps).length;
    res.json({ success:true, steps, progress:`${completed}/${total}`, percent:Math.round(completed/total*100) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TEMPLATES LIBRARY
// ============================================================

app.get("/templates", async (req, res) => {
  try {
    const { category, search } = req.query;
    let q = supabase.from("business_type_templates").select("id,code,name,category,icon,description,delivery_type,currency").eq("is_active", true).order("sort_order");
    if (category) q = q.eq("category", category);
    if (search)   q = q.ilike("name", `%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, templates:data, total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/templates/:code", async (req, res) => {
  try {
    const { data: tpl } = await supabase.from("business_type_templates").select("*").eq("code", req.params.code).single();
    if (!tpl) return res.status(404).json({ error: "Template not found." });
    const { data: products } = await supabase.from("template_products").select("*").eq("template_id", tpl.id).order("sort_order");
    const { data: kb }       = await supabase.from("template_kb").select("*").eq("template_id", tpl.id).order("sort_order");
    const { data: settings } = await supabase.from("template_settings").select("*").eq("template_id", tpl.id).single();
    res.json({ success:true, template:tpl, preview:{ products:products||[], kb:kb||[], settings:settings||null } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// PRODUCTS API (with EDIT support)
// ============================================================

app.get("/api/products", requireAuth, async (req, res) => {
  try {
    const { page=1, limit=50, category, search } = req.query;
    let q = supabase.from("products").select("*",{count:"exact"}).eq("business_id", req.business.id).order("created_at",{ascending:false}).range((page-1)*limit, page*limit-1);
    if (category) q = q.eq("category", category);
    if (search)   q = q.ilike("name", `%${search}%`);
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ success:true, products:data, total:count, page:Number(page) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/products", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { count } = await supabase.from("products").select("id",{count:"exact",head:true}).eq("business_id", req.business.id);
    if ((count||0) >= limits.product_limit) return res.status(403).json({ error:`Product limit (${limits.product_limit}) reached. Upgrade to add more.` });
    const { name,description,category,price,salePrice,currency,type,stock,digitalLink,digitalCode,imageUrl,keywords,tags,sku } = req.body;
    if (!name||!price) return res.status(400).json({ error:"Product name and price required." });
    const { data, error } = await supabase.from("products").insert({
      business_id:req.business.id, sku:sku||null, name,
      description:description||null, category:category||"general",
      price:parseFloat(price), sale_price:salePrice?parseFloat(salePrice):null,
      currency:currency||"NGN", type:type||"physical",
      stock:stock!==undefined&&stock!==""?parseInt(stock):null,
      digital_link:digitalLink||null, digital_code:digitalCode||null,
      image_url:imageUrl||null, keywords:keywords||[], tags:tags||[], imported_from:"manual",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success:true, product:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// EDIT product — PATCH /api/products/:id
app.patch("/api/products/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","description","category","price","sale_price","currency","type","stock","digital_link","digital_code","image_url","keywords","tags","sku","is_active","is_featured","salePrice"];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Map camelCase to snake_case
        const dbKey = key === "salePrice" ? "sale_price" : key;
        updates[dbKey] = req.body[key];
      }
    }
    const { data, error } = await supabase.from("products").update(updates).eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Product not found." });
    res.json({ success:true, product:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/products/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("products").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/products/import", requireAuth, requirePlan("excel_import"), async (req, res) => {
  try {
    const { products } = req.body;
    if (!products||!Array.isArray(products)||products.length===0) return res.status(400).json({ error:"No products data." });
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { count } = await supabase.from("products").select("id",{count:"exact",head:true}).eq("business_id", req.business.id);
    const canAdd = limits.product_limit - (count||0);
    if (canAdd<=0) return res.status(403).json({ error:"Product limit reached." });
    const { data: imp } = await supabase.from("bulk_imports").insert({ business_id:req.business.id,type:"products",total_rows:products.length,status:"processing" }).select().single();
    const errors=[], rows=[];
    for (let i=0; i<products.slice(0,canAdd).length; i++) {
      const p = products[i];
      if (!p.name||!p.price) { errors.push({row:i+2,error:`Row ${i+2}: name and price required`}); continue; }
      rows.push({ business_id:req.business.id,sku:p.sku||null,name:String(p.name).trim(),description:p.description?String(p.description).trim():null,category:p.category||"general",price:parseFloat(p.price)||0,sale_price:p.sale_price?parseFloat(p.sale_price):null,currency:p.currency||"NGN",type:p.type||"physical",stock:p.stock!==undefined&&p.stock!==""?parseInt(p.stock):null,digital_link:p.digital_link||null,digital_code:p.digital_code||null,image_url:p.image_url||null,keywords:p.keywords?String(p.keywords).split(",").map(k=>k.trim()):[],tags:p.tags?String(p.tags).split(",").map(t=>t.trim()):[],imported_from:"excel",import_batch_id:imp.id });
    }
    let imported=0;
    if (rows.length>0) { const { data:ins } = await supabase.from("products").insert(rows).select(); imported=ins?.length||0; }
    await supabase.from("bulk_imports").update({ imported_rows:imported,failed_rows:errors.length,errors,status:"done",completed_at:new Date().toISOString() }).eq("id", imp.id);
    res.json({ success:true, message:`✅ ${imported} products imported.`, imported, failed:errors.length, errors:errors.slice(0,10) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// PAYMENT SYSTEM
// TWO METHODS:
// Method A: Paystack API (auto-confirm) — for subscribers WITH API keys
// Method B: Manual bank/OPay/PalmPay (manual confirm) — for ALL subscribers
// ============================================================

// GET /payment-methods/:businessId — What payment methods does this business accept?
app.get("/payment-methods/:businessId", async (req, res) => {
  try {
    const { data: settings } = await supabase.from("business_settings")
      .select("paystack_secret,bank_details").eq("business_id", req.params.businessId).single();
    const methods = [];
    if (settings?.paystack_secret) methods.push({ id:"paystack", name:"Card / Bank Transfer / USSD", icon:"💳", type:"auto", note:"Instant confirmation via Paystack" });
    const bd = settings?.bank_details || {};
    if (bd.bank_name&&bd.account_number) methods.push({ id:"bank_transfer", name:`Bank Transfer (${bd.bank_name})`, icon:"🏦", type:"manual", details:{ bank:bd.bank_name, account:bd.account_number, name:bd.account_name } });
    if (bd.opay_number)       methods.push({ id:"opay",       name:"OPay",       icon:"📱", type:"manual", details:{ number:bd.opay_number,       name:bd.account_name } });
    if (bd.palmpay_number)    methods.push({ id:"palmpay",    name:"PalmPay",    icon:"📱", type:"manual", details:{ number:bd.palmpay_number,    name:bd.account_name } });
    if (bd.kuda_number)       methods.push({ id:"kuda",       name:"Kuda Bank",  icon:"🏦", type:"manual", details:{ number:bd.kuda_number,       name:bd.account_name } });
    if (bd.moniepoint_number) methods.push({ id:"moniepoint", name:"Moniepoint", icon:"💰", type:"manual", details:{ number:bd.moniepoint_number, name:bd.account_name } });
    if (bd.cash_on_delivery)  methods.push({ id:"cash",       name:"Cash on Delivery", icon:"💵", type:"manual", details:{ note:bd.cod_note||"Pay when you receive your item" } });
    if (!methods.length) methods.push({ id:"contact", name:"Contact Business Directly", icon:"📞", type:"manual", details:{ note:"Message us to arrange payment" } });
    res.json({ success:true, methods, hasPaystack:!!settings?.paystack_secret });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /dashboard/bank-details — Subscriber saves their payment details
app.patch("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const { bankName,accountNumber,accountName,opayNumber,palmpayNumber,kudaNumber,moniepointNumber,cashOnDelivery,codNote } = req.body;
    const bankDetails = {};
    if (bankName)         bankDetails.bank_name          = bankName;
    if (accountNumber)    bankDetails.account_number     = accountNumber;
    if (accountName)      bankDetails.account_name       = accountName;
    if (opayNumber)       bankDetails.opay_number        = opayNumber;
    if (palmpayNumber)    bankDetails.palmpay_number     = palmpayNumber;
    if (kudaNumber)       bankDetails.kuda_number        = kudaNumber;
    if (moniepointNumber) bankDetails.moniepoint_number  = moniepointNumber;
    if (cashOnDelivery!==undefined) bankDetails.cash_on_delivery = cashOnDelivery;
    if (codNote)          bankDetails.cod_note           = codNote;
    await supabase.from("business_settings").update({ bank_details:bankDetails, updated_at:new Date().toISOString() }).eq("business_id", req.business.id);
    res.json({ success:true, message:"✅ Payment details saved! Customers can now pay via your bank/payment details.", bankDetails });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /dashboard/bank-details
app.get("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("business_settings").select("bank_details,paystack_public,paystack_secret").eq("business_id", req.business.id).single();
    res.json({ success:true, bankDetails:data?.bank_details||{}, hasPaystack:!!(data?.paystack_secret), paystackPublic:data?.paystack_public||"" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /dashboard/orders/:id/confirm-payment — Manually confirm a bank/OPay/PalmPay payment
app.post("/dashboard/orders/:id/confirm-payment", requireAuth, async (req, res) => {
  try {
    const { paymentMethod, reference, amountReceived, note } = req.body;
    const { data: order } = await supabase.from("orders").select("*").eq("id", req.params.id).eq("business_id", req.business.id).single();
    if (!order) return res.status(404).json({ error: "Order not found." });
    await supabase.from("orders").update({
      status:"paid", paystack_status:"success",
      paystack_ref:reference||`MANUAL-${Date.now()}`,
      paid_at:new Date().toISOString(),
      payment_method:paymentMethod||"manual",
      notes:note||`Manual payment confirmed via ${paymentMethod||"bank"}`,
      updated_at:new Date().toISOString(),
    }).eq("id", req.params.id);
    await supabase.from("payments").insert({ business_id:req.business.id,order_id:req.params.id,type:"order",amount:amountReceived||order.total,currency:order.currency,paystack_ref:reference||`MANUAL-${Date.now()}`,status:"success",plan:paymentMethod||"manual" }).catch(()=>{});

    // Deliver digital product
    if (order.delivery_type==="digital"&&!order.digital_sent) {
      const { data: bizSettings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
      const { data: contact } = await supabase.from("contacts").select("phone").eq("id", order.contact_id).single();
      if (bizSettings&&contact) {
        let msg = `🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} paid!\n\n📥 *Your Product:*\n`;
        for (const item of (order.items||[])) {
          const { data: p } = await supabase.from("products").select("digital_link,digital_code").eq("id", item.product_id).single();
          if (p?.digital_link) msg += `🔗 Download: ${p.digital_link}\n`;
          if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
        }
        msg += `\nThank you! 🙏 Type MENU to shop again.`;
        const tok = bizSettings.wa_access_token||process.env.WA_ACCESS_TOKEN;
        await sendWA(bizSettings.wa_phone_id, tok, contact.phone, msg);
        await supabase.from("orders").update({ digital_sent:true,digital_sent_at:new Date().toISOString(),status:"delivered" }).eq("id", req.params.id);
      }
    }
    res.json({ success:true, message:"✅ Payment confirmed! Order updated." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/subscribe — Platform subscription (subscriber pays YOU via Paystack)
app.post("/api/subscribe", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLAN_PRICES_NGN[plan]) return res.status(400).json({ error:"Invalid plan. Choose: starter, growth, or pro." });
    const response = await axios.post("https://api.paystack.co/transaction/initialize",
      { email:req.business.email, amount:PLAN_PRICES_NGN[plan]*100, currency:"NGN",
        reference:`SUB-${req.business.id.substring(0,8)}-${Date.now()}`,
        metadata:{ business_id:req.business.id, plan, type:"subscription", username:req.business.username },
        callback_url:`${process.env.FRONTEND_URL}/dashboard.html?upgraded=1` },
      { headers:{ Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json({ success:true, paymentLink:response.data?.data?.authorization_url, plan, amount:`₦${PLAN_PRICES_NGN[plan].toLocaleString()}/month` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// DASHBOARD API
// ============================================================

app.get("/dashboard/stats", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("business_dashboard").select("*").eq("id", req.business.id).single();
    if (error) throw error;
    const { data: errs } = await supabase.from("error_reports").select("id").eq("business_id", req.business.id).eq("resolved", false);
    res.json({ success:true, stats:{ ...data, unresolved_errors:errs?.length||0, plan_limits:PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { data, count, error } = await supabase.from("knowledge_base").select("*",{count:"exact"}).eq("business_id", req.business.id).order("uses",{ascending:false});
    if (error) throw error;
    res.json({ success:true, entries:data, total:count, limit:limits.kb_limit, can_add:(count||0)<limits.kb_limit });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id",{count:"exact",head:true}).eq("business_id", req.business.id);
    if ((count||0)>=limits.kb_limit) return res.status(403).json({ error:`KB limit (${limits.kb_limit}) reached. Upgrade to add more.` });
    const { keyword,answer,category,language } = req.body;
    if (!keyword||!answer) return res.status(400).json({ error:"Keyword and answer required." });
    const { data, error } = await supabase.from("knowledge_base").insert({ business_id:req.business.id,keyword,answer,category:category||"general",language:language||"en" }).select().single();
    if (error) throw error;
    res.json({ success:true, entry:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/dashboard/kb/:id/toggle", requireAuth, async (req, res) => {
  try {
    const { data: entry } = await supabase.from("knowledge_base").select("is_active").eq("id", req.params.id).eq("business_id", req.business.id).single();
    if (!entry) return res.status(404).json({ error:"KB entry not found." });
    const { data, error } = await supabase.from("knowledge_base").update({ is_active:!entry.is_active,updated_at:new Date().toISOString() }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success:true, entry:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/dashboard/kb/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("knowledge_base").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/ai-logs", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("ai_promotion_candidates").select("*").eq("business_id", req.business.id).limit(50);
    if (error) throw error;
    res.json({ success:true, candidates:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/dashboard/ai-logs/:id/promote", requireAuth, async (req, res) => {
  try {
    const { customAnswer,category,language } = req.body;
    const { data: log } = await supabase.from("ai_logs").select("*").eq("id", req.params.id).single();
    if (!log) return res.status(404).json({ error:"Log not found." });
    const { data: kbEntry, error } = await supabase.from("knowledge_base").insert({ business_id:log.business_id,keyword:log.incoming_msg.substring(0,100),answer:customAnswer||log.ai_response,category:category||"general",language:language||"en",confidence:log.confidence||0.85,promoted_from_ai:true }).select().single();
    if (error) throw error;
    await supabase.from("ai_logs").update({ promoted_to_kb:true }).eq("id", req.params.id);
    res.json({ success:true, message:"✅ Promoted to KB!", kbEntry });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/contacts", requireAuth, async (req, res) => {
  try {
    const { page=1,limit=50,tag,segment,search } = req.query;
    let q = supabase.from("contacts").select("*",{count:"exact"}).eq("business_id", req.business.id).order("last_seen",{ascending:false}).range((page-1)*limit, page*limit-1);
    if (tag)     q = q.contains("tags",[tag]);
    if (segment) q = q.eq("segment", segment);
    if (search)  q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ success:true, contacts:data, total:count, page:Number(page) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/orders", requireAuth, async (req, res) => {
  try {
    const { page=1,limit=50,status } = req.query;
    let q = supabase.from("orders").select("*,contacts(name,phone)",{count:"exact"}).eq("business_id", req.business.id).order("created_at",{ascending:false}).range((page-1)*limit, page*limit-1);
    if (status) q = q.eq("status", status);
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ success:true, orders:data, total:count, page:Number(page) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/dashboard/orders/:id", requireAuth, async (req, res) => {
  try {
    const { status,trackingNumber,notes } = req.body;
    const updates = { updated_at:new Date().toISOString() };
    if (status)         updates.status          = status;
    if (trackingNumber) updates.tracking_number = trackingNumber;
    if (notes)          updates.notes           = notes;
    const { data, error } = await supabase.from("orders").update(updates).eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success:true, order:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/broadcasts", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { data, error } = await supabase.from("broadcasts").select("*").eq("business_id", req.business.id).order("created_at",{ascending:false});
    if (error) throw error;
    res.json({ success:true, broadcasts:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/dashboard/broadcasts/send", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { title,message,targetTags,targetSegment } = req.body;
    if (!message) return res.status(400).json({ error:"Message is required." });
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (!settings?.wa_phone_id) return res.status(400).json({ error:"WhatsApp not configured. Complete setup first." });
    let q = supabase.from("contacts").select("phone,name").eq("business_id", req.business.id).eq("opted_in", true);
    if (targetTags?.length) q = q.overlaps("tags", targetTags);
    if (targetSegment) q = q.eq("segment", targetSegment);
    const { data: contacts } = await q.limit(limits.broadcast_limit);
    if (!contacts?.length) return res.json({ success:false, message:"No contacts found." });
    const { data: broadcast } = await supabase.from("broadcasts").insert({ business_id:req.business.id,title:title||"Broadcast",message,target_tags:targetTags||[],recipients_count:contacts.length,status:"sending" }).select().single();
    const tok = settings.wa_access_token||process.env.WA_ACCESS_TOKEN;
    for (const c of contacts) {
      msgQueue.add(req.business.id, settings.wa_phone_id, tok, c.phone, message.replace("{name}", c.name||"Friend"));
    }
    await supabase.from("broadcasts").update({ status:"queued",sent_at:new Date().toISOString() }).eq("id", broadcast.id);
    res.json({ success:true, message:`✅ ${contacts.length} messages queued!`, queued:contacts.length, estimatedSeconds:Math.ceil(contacts.length/60) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/referrals", requireAuth, async (req, res) => {
  try {
    const { data: refs } = await supabase.from("referrals").select("*").eq("referrer_id", req.business.id).order("created_at",{ascending:false});
    res.json({ success:true, referralCode:req.business.referral_code, referralLink:`${process.env.FRONTEND_URL}?ref=${req.business.referral_code}`, totalReferrals:req.business.referral_count||0, referrals:refs||[] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (error) throw error;
    if (data?.wa_access_token) data.wa_access_token = data.wa_access_token.substring(0,20)+"...";
    if (data?.paystack_secret) data.paystack_secret = "sk_***hidden***";
    res.json({ success:true, settings:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const allowed=["greeting_msg","fallback_msg","away_msg","auto_reply","ai_enabled","collect_leads","watermark","away_mode","business_hours_start","business_hours_end","timezone","notify_new_order","notify_payment","notify_email","ai_personality","custom_instructions"];
    const updates={ updated_at:new Date().toISOString() };
    for (const k of allowed) { if (req.body[k]!==undefined) updates[k]=req.body[k]; }
    const { data, error } = await supabase.from("business_settings").update(updates).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success:true, settings:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/dashboard/profile", requireAuth, async (req, res) => {
  try {
    const allowed=["business_name","business_desc","business_category","contact_phone","contact_email","address","city","state","country","delivery_areas","delivery_fee","delivery_days","free_delivery_above"];
    const updates={ updated_at:new Date().toISOString() };
    for (const k of allowed) { if (req.body[k]!==undefined) updates[k]=req.body[k]; }
    const { data, error } = await supabase.from("businesses").update(updates).eq("id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success:true, business:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/queue-status", requireAuth, (req, res) => {
  res.json({ success:true, queue:msgQueue.status(req.business.id) });
});

// ============================================================
// GLOBAL KEYWORD LIBRARY
// ============================================================

app.get("/global-kb", async (req, res) => {
  try {
    const { category,language,industry,search } = req.query;
    let q = supabase.from("global_kb_library").select("*").eq("is_active", true).order("uses",{ascending:false});
    if (category) q = q.eq("category", category);
    if (language) q = q.eq("language", language);
    if (industry&&industry!=="all") q = q.in("industry",[industry,"all"]);
    if (search)   q = q.or(`keyword.ilike.%${search}%,answer.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, keywords:data, total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/global-kb/:id/copy", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id",{count:"exact",head:true}).eq("business_id", req.business.id);
    if ((count||0)>=limits.kb_limit) return res.status(403).json({ error:`KB limit reached. Upgrade to add more.` });
    const { data: entry } = await supabase.from("global_kb_library").select("*").eq("id", req.params.id).eq("is_active", true).single();
    if (!entry) return res.status(404).json({ error:"Keyword not found." });
    const { data: existing } = await supabase.from("knowledge_base").select("id").eq("business_id", req.business.id).ilike("keyword", entry.keyword).single();
    if (existing) return res.status(409).json({ error:"You already have this keyword in your KB." });
    const { customAnswer } = req.body;
    const { data: kbEntry, error } = await supabase.from("knowledge_base").insert({ business_id:req.business.id,keyword:entry.keyword,answer:customAnswer||entry.answer,category:entry.category,language:entry.language,is_active:true }).select().single();
    if (error) throw error;
    await supabase.from("global_kb_library").update({ uses:entry.uses+1 }).eq("id", req.params.id);
    res.json({ success:true, message:"✅ Keyword copied to your KB!", entry:kbEntry });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/global-kb/copy-all", requireAuth, async (req, res) => {
  try {
    const { industry,language } = req.body;
    const limits = PLAN_LIMITS[req.business.plan]||PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id",{count:"exact",head:true}).eq("business_id", req.business.id);
    const slotsLeft = limits.kb_limit-(count||0);
    if (slotsLeft<=0) return res.status(403).json({ error:"KB limit reached." });
    let q = supabase.from("global_kb_library").select("*").eq("is_active", true).order("uses",{ascending:false});
    if (industry&&industry!=="all") q = q.in("industry",[industry,"all"]);
    if (language) q = q.eq("language", language);
    const { data: globals } = await q.limit(slotsLeft);
    if (!globals?.length) return res.json({ success:true, copied:0 });
    const { data: existing } = await supabase.from("knowledge_base").select("keyword").eq("business_id", req.business.id);
    const existingKws = new Set((existing||[]).map(e=>e.keyword.toLowerCase()));
    const toInsert = globals.filter(g=>!existingKws.has(g.keyword.toLowerCase())).map(g=>({ business_id:req.business.id,keyword:g.keyword,answer:g.answer,category:g.category,language:g.language,is_active:true }));
    if (!toInsert.length) return res.json({ success:true, copied:0, message:"All keywords already in your KB." });
    const { data: inserted, error } = await supabase.from("knowledge_base").insert(toInsert).select();
    if (error) throw error;
    res.json({ success:true, copied:inserted?.length||0, message:`✅ ${inserted?.length} keywords added!` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/global-kb", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { keyword,answer,category,language,industry } = req.body;
    if (!keyword||!answer) return res.status(400).json({ error:"Keyword and answer required." });
    const { data, error } = await supabase.from("global_kb_library").insert({ keyword,answer,category:category||"general",language:language||"en",industry:industry||"all",created_by:req.business.username }).select().single();
    if (error) throw error;
    res.status(201).json({ success:true, keyword:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/global-kb/:id", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { data, error } = await supabase.from("global_kb_library").update({ ...req.body }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success:true, keyword:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SHARED NUMBER — Two subscriber methods
// METHOD 1: Subscriber uses YOUR number (type @username)
// METHOD 2: Subscriber has their OWN number (direct routing)
// ============================================================

app.get("/shared/directory", async (req, res) => {
  try {
    const { category,search } = req.query;
    let q = supabase.from("businesses").select("id,username,business_name,business_category,business_desc,city").eq("is_active", true).not("business_name","is",null);
    if (category) q = q.eq("business_category", category);
    if (search)   q = q.ilike("business_name",`%${search}%`);
    const { data } = await q.order("referral_count",{ascending:false}).limit(50);
    res.json({ success:true, businesses:data||[], sharedNumber:process.env.SHARED_WA_NUMBER||"" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/shared/qr/:username", async (req, res) => {
  try {
    const { data: biz } = await supabase.from("businesses").select("username,business_name").eq("username", req.params.username.toLowerCase()).single();
    if (!biz) return res.status(404).json({ error:"Business not found." });
    const num    = (process.env.SHARED_WA_NUMBER||"").replace(/\D/g,"");
    const waLink = `https://wa.me/${num}?text=@${biz.username}`;
    const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(waLink)}`;
    res.json({ success:true, business:biz.business_name, shortcode:`@${biz.username}`, waLink, qrCodeUrl:qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// WHATSAPP WEBHOOK — Routes to correct business
// Handles BOTH shared number AND individual numbers
// ============================================================

async function searchKB(bizId, message, lang) {
  const { data: entries } = await supabase.from("knowledge_base").select("*").eq("business_id", bizId).eq("is_active", true).in("language",[lang,"en"]);
  if (!entries?.length) return null;
  let best=null, bestScore=0;
  for (const e of entries) { const score=fuzzy(message,e.keyword); if (score>bestScore) { bestScore=score; best={...e,matchScore:score}; } }
  if (bestScore>=0.75) {
    await supabase.from("knowledge_base").update({ uses:best.uses+1,updated_at:new Date().toISOString() }).eq("id", best.id);
    return best;
  }
  return null;
}

async function callQwen(message, biz, lang, intent, settings) {
  const HF_TOKEN = process.env.HF_API_KEY;
  if (!HF_TOKEN) throw new Error("HF_API_KEY not set in Render environment");

  const sys = `You are a ${settings?.ai_personality||"friendly"} WhatsApp sales assistant for "${biz.business_name}", an African business.\nBusiness: ${biz.business_desc||"Quality products and services."}\nLocation: ${biz.city||""} ${biz.country||"Nigeria"}\nDelivery: ${biz.delivery_days||"1-3 days"} | Fee: ${biz.currency||"NGN"} ${biz.delivery_fee||0}\n${settings?.custom_instructions?`Instructions: ${settings.custom_instructions}`:""}\nRules: Keep replies under 100 words. Be warm. Use 1-2 emojis. End with a CTA. Never make up prices. Intent: ${intent}. Language: ${lang==="pidgin"?"Nigerian Pidgin":lang==="yo"?"Yoruba-friendly English":lang==="ha"?"Hausa-friendly English":lang==="ig"?"Igbo-friendly English":"English"}`;

  const start = Date.now();
  for (let i=1; i<=3; i++) {
    try {
      const r = await axios.post(HF_API,
        {
          model: `${HF_MODEL}:fastest`,
          stream: false,
          messages: [
            { role:"system", content:sys },
            { role:"user", content:message }
          ],
          max_tokens: 150,
          temperature: 0.7,
          top_p: 0.9
        },
        { headers:{ Authorization:`Bearer ${HF_TOKEN}`,"Content-Type":"application/json" }, timeout:30000 }
      );

      let text = r.data?.choices?.[0]?.message?.content || r.data?.choices?.[0]?.text || "";
      text = String(text).replace(/<\|im_end\|>/g,"").replace(/<\|im_start\|>/g,"").trim();
      if (!text) throw new Error("Empty Qwen response");
      return { text, latency:Date.now()-start };
    } catch(err) {
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message || err.response?.data?.error || err.response?.data?.message || err.message;
      if (i<3) {
        if (status===503) { await sleep(5000); continue; }
        if (status===429) { await sleep(10000); continue; }
      }
      throw new Error(`Qwen API failed${status?` (${status})`:""}: ${typeof detail==="string"?detail:JSON.stringify(detail)}`);
    }
  }
}

async function handleBotMessage(fromPhone, messageText, contactName, business, settings, phoneId, token) {
  const plan       = business.plan||"free";
  const planLimits = PLAN_LIMITS[plan]||PLAN_LIMITS.free;
  const addWM      = !planLimits.remove_watermark;
  const wrap       = t => addWM ? t+WATERMARK : t;
  const used       = business.reply_count||0;
  const limit      = business.reply_limit||100;

  if (plan!=="pro"&&used>=limit) {
    await sendWA(phoneId, token, fromPhone, `⚠️ This business has reached its monthly reply limit. Please contact them directly.`);
    return;
  }

  // Get/create contact
  const { data: existC } = await supabase.from("contacts").select("*").eq("business_id", business.id).eq("phone", fromPhone).single();
  let contact = existC;
  if (existC) {
    await supabase.from("contacts").update({ last_seen:new Date().toISOString() }).eq("id", existC.id);
  } else {
    const { data: newC } = await supabase.from("contacts").insert({ business_id:business.id,phone:fromPhone,name:contactName }).select().single();
    contact = newC;
  }

  const lang    = detectLang(messageText);
  const intent  = detectIntent(messageText);
  const incR    = () => supabase.from("businesses").update({ reply_count:used+1 }).eq("id", business.id);

  // Payment details message builder
  const buildPaymentMsg = (order, matchedProduct) => {
    let msg = `💳 *Payment Options:*\n\n`;
    // We will fetch payment methods inline
    return msg;
  };

  // MENU
  if (/^(menu|help|start|options?)$/i.test(messageText.trim())) {
    await sendWA(phoneId, token, fromPhone, wrap(`🤖 *${business.business_name} — Menu*\n\n🛍️ *CATALOG* — Browse products\n💰 *PRICE* — See prices\n📦 *TRACK [no]* — Track order\n📞 *CONTACT* — Our team\n🚀 *ORDER [name]* — Place order\n💳 *PAYMENT* — How to pay\n\nOr just ask me anything! 😊`));
    await incR(); return;
  }

  // CATALOG/PRICE
  if (/^(catalog|products?|shop|browse|list|price|how much)$/i.test(messageText.trim())) {
    const { data: prods } = await supabase.from("products").select("name,price,currency,sale_price,type,description").eq("business_id", business.id).eq("is_active", true).limit(10);
    let cat = `🛒 *${business.business_name} — Products*\n\n`;
    if (prods?.length) {
      prods.forEach((p,i) => {
        const dp = p.sale_price ? `~~${p.currency} ${Number(p.price).toLocaleString()}~~ *${p.currency} ${Number(p.sale_price).toLocaleString()}* 🔥` : `${p.currency} ${Number(p.price).toLocaleString()}`;
        cat += `${i+1}. *${p.name}*\n   💰 ${dp}\n`;
        if (p.description) cat += `   ${p.description.substring(0,60)}\n`;
        cat += `   ${p.type==="digital"?"⚡ Digital":"📦 Physical"}\n\n`;
      });
      cat += `Reply *ORDER [product name]* to buy!`;
    } else { cat += `No products listed yet. Type *CONTACT* to ask! 😊`; }
    await sendWA(phoneId, token, fromPhone, wrap(cat));
    await incR(); return;
  }

  // PAYMENT INFO
  if (/^(payment|how to pay|pay)$/i.test(messageText.trim())) {
    const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret,bank_details").eq("business_id", business.id).single();
    const bd = bizSettings?.bank_details||{};
    let payMsg = `💳 *Payment Options for ${business.business_name}*\n\n`;
    if (bizSettings?.paystack_secret) payMsg += `✅ *Card / Bank Transfer / USSD*\n   Secure checkout via Paystack\n   Instant confirmation!\n\n`;
    if (bd.bank_name&&bd.account_number) payMsg += `🏦 *Bank Transfer*\n   Bank: ${bd.bank_name}\n   Account: ${bd.account_number}\n   Name: ${bd.account_name||""}\n\n`;
    if (bd.opay_number)    payMsg += `📱 *OPay:* ${bd.opay_number} (${bd.account_name||""})\n`;
    if (bd.palmpay_number) payMsg += `📱 *PalmPay:* ${bd.palmpay_number} (${bd.account_name||""})\n`;
    if (bd.kuda_number)    payMsg += `🏦 *Kuda:* ${bd.kuda_number} (${bd.account_name||""})\n`;
    if (bd.moniepoint_number) payMsg += `💰 *Moniepoint:* ${bd.moniepoint_number} (${bd.account_name||""})\n`;
    if (bd.cash_on_delivery) payMsg += `💵 *Cash on Delivery* available!\n`;
    if (!bizSettings?.paystack_secret&&!bd.bank_name&&!bd.opay_number) payMsg += `📞 Contact us to arrange payment!\n`;
    payMsg += `\nType *ORDER [product name]* to start your order!`;
    await sendWA(phoneId, token, fromPhone, wrap(payMsg));
    await incR(); return;
  }

  // CONTACT
  if (/^(contact|support|human|agent|talk)$/i.test(messageText.trim())) {
    const ph = business.contact_phone||business.phone;
    await sendWA(phoneId, token, fromPhone, wrap(`📞 *Contact ${business.business_name}*\n\nPhone: ${ph}\n${business.contact_email?`Email: ${business.contact_email}\n`:""}${business.city?`Location: ${business.city}\n`:""}\nWe respond within 2 hours! 😊`));
    await incR(); return;
  }

  // DELIVERY
  if (/^(delivery|deliver|shipping|ship)$/i.test(messageText.trim())) {
    const areas = business.delivery_areas?.length ? business.delivery_areas.join(", ") : "Nationwide";
    await sendWA(phoneId, token, fromPhone, wrap(`📦 *Delivery Info*\n\n📍 Areas: ${areas}\n⏱️ Time: ${business.delivery_days||"1-3 business days"}\n💰 Fee: ${business.currency||"NGN"} ${Number(business.delivery_fee||0).toLocaleString()}${business.free_delivery_above?`\n🎁 FREE above ${business.currency||"NGN"} ${Number(business.free_delivery_above).toLocaleString()}`:""}\n\nType *ORDER [product]* to buy! 🛍️`));
    await incR(); return;
  }

  // UPGRADE
  if (/^(upgrade|subscribe|pricing|plan)$/i.test(messageText.trim())) {
    await sendWA(phoneId, token, fromPhone, wrap(`🚀 *Upgrade VendrAI*\n\n✅ *Starter* — ₦4,900/mo → 500 replies\n✅ *Growth* — ₦14,900/mo → 3,000 replies\n✅ *Pro* — ₦29,900/mo → Unlimited\n\n14-day FREE trial!\n👉 ${process.env.FRONTEND_URL}/pricing.html`));
    await incR(); return;
  }

  // TRACK
  if (/^(track|status)\s+\S+/i.test(messageText.trim())) {
    const ref = messageText.trim().split(/\s+/).slice(1).join(" ");
    const { data: ord } = await supabase.from("orders").select("*").eq("business_id", business.id).eq("contact_id", contact?.id).or(`order_number.ilike.%${ref}%,id.ilike.${ref}%`).single();
    if (ord) {
      await sendWA(phoneId, token, fromPhone, wrap(`📍 *Order Status*\n\n🆔 ${ord.order_number}\n📦 Status: *${ord.status.toUpperCase()}*\n💳 Payment: ${ord.paystack_status}\n📅 ${new Date(ord.created_at).toLocaleDateString()}${ord.tracking_number?`\n🚚 Tracking: ${ord.tracking_number}`:""}\n\nType *CONTACT* for help! 😊`));
      await incR(); return;
    }
  }

  // ORDER
  if (/^order\s+.+/i.test(messageText.trim())) {
    const query = messageText.replace(/^order\s+/i,"").trim();
    const { data: prods } = await supabase.from("products").select("*").eq("business_id", business.id).eq("is_active", true);
    let matched=null;
    if (prods) for (const p of prods) { if (fuzzy(query,p.name)>0.5) { matched=p; break; } }
    if (matched) {
      const price       = matched.sale_price||matched.price;
      const deliveryFee = matched.type==="digital" ? 0 : (business.delivery_fee||0);
      const total       = price+deliveryFee;
      const { data: order } = await supabase.from("orders").insert({
        business_id:business.id,contact_id:contact?.id,
        order_number:`ORD-${Date.now().toString(36).toUpperCase()}`,
        items:[{ product_id:matched.id,name:matched.name,qty:1,price,currency:matched.currency }],
        subtotal:price,delivery_fee:deliveryFee,total,currency:matched.currency||"NGN",delivery_type:matched.type,status:"pending",
      }).select().single();

      // Build payment message based on available methods
      const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret,bank_details,paystack_public").eq("business_id", business.id).single();
      let orderMsg = `✅ *Order Created!*\n\n📦 ${matched.name}\n💰 ${matched.currency} ${Number(price).toLocaleString()}\n🚚 Delivery: ${matched.currency} ${Number(deliveryFee).toLocaleString()}\n💵 *Total: ${matched.currency} ${Number(total).toLocaleString()}*\n🆔 ${order.order_number}\n\n`;

      // Try Paystack first (auto-confirm)
      if (bizSettings?.paystack_secret) {
        try {
          const resp = await axios.post("https://api.paystack.co/transaction/initialize",
            { email:`${fromPhone.replace("+","")}@vendrai.app`,amount:total*100,currency:matched.currency||"NGN",
              reference:`VND-${order.id.substring(0,8).toUpperCase()}`,
              metadata:{ order_id:order.id,business_id:business.id,contact_phone:fromPhone },
              callback_url:`${process.env.BACKEND_URL}/webhook/paystack/verify` },
            { headers:{ Authorization:`Bearer ${bizSettings.paystack_secret}`,"Content-Type":"application/json" } }
          );
          const payLink = resp.data?.data?.authorization_url||"";
          if (payLink) {
            await supabase.from("orders").update({ payment_link:payLink }).eq("id", order.id);
            orderMsg += `👇 *Pay securely here:*\n${payLink}\n\n⚡ Payment confirmed automatically!`;
          }
        } catch(e) { console.error("Paystack error:", e.message); }
      }

      // If no Paystack — show bank/manual payment details
      if (!orderMsg.includes("paystack.com")&&!orderMsg.includes("flutterwave")) {
        const bd = bizSettings?.bank_details||{};
        orderMsg += `💳 *How to Pay:*\n`;
        if (bd.bank_name&&bd.account_number) orderMsg += `🏦 ${bd.bank_name}: ${bd.account_number} (${bd.account_name||""})\n`;
        if (bd.opay_number)    orderMsg += `📱 OPay: ${bd.opay_number}\n`;
        if (bd.palmpay_number) orderMsg += `📱 PalmPay: ${bd.palmpay_number}\n`;
        if (bd.kuda_number)    orderMsg += `🏦 Kuda: ${bd.kuda_number}\n`;
        if (bd.moniepoint_number) orderMsg += `💰 Moniepoint: ${bd.moniepoint_number}\n`;
        if (bd.cash_on_delivery) orderMsg += `💵 Cash on Delivery available!\n`;
        orderMsg += `\nAfter payment, send proof here. We confirm within 30 minutes!`;
      }

      await sendWA(phoneId, token, fromPhone, wrap(orderMsg));

      // Notify subscriber of new order
      notifySubscriber(business.id,
        `🛍️ *New Order!*\n\n📦 ${matched.name}\n💰 ${matched.currency} ${Number(total).toLocaleString()}\n📱 From: ${fromPhone}\n🆔 ${order.order_number}\n\nLogin to confirm: ${process.env.FRONTEND_URL}/dashboard.html`
      ).catch(()=>{});

      await supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:orderMsg,kb_hit:false,status:"success",confidence:1.0 }).catch(()=>{});
      await incR(); return;
    }
  }

  // KNOWLEDGE BASE
  const kbMatch = await searchKB(business.id, messageText, lang);
  if (kbMatch) {
    await sendWA(phoneId, token, fromPhone, wrap(kbMatch.answer));
    await incR();
    await supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:kbMatch.answer,kb_hit:true,kb_entry_id:kbMatch.id,status:"success",confidence:kbMatch.matchScore }).catch(()=>{});
    return;
  }

  // QWEN AI (last resort)
  if (settings?.ai_enabled!==false&&planLimits.ai_enabled) {
    try {
      const aiResult = await callQwen(messageText, business, lang, intent, settings);
      await sendWA(phoneId, token, fromPhone, wrap(aiResult.text));
      await incR();
      await supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:aiResult.text,kb_hit:false,model_used:"qwen",latency_ms:aiResult.latency,status:"success",confidence:0.85 }).catch(()=>{});
      return;
    } catch(aiErr) {
      console.error("❌ AI failed:", aiErr.message);
      const fallback = settings?.fallback_msg||`Thanks for your message! 😊 Type MENU for options or CONTACT to reach our team.`;
      await sendWA(phoneId, token, fromPhone, wrap(fallback));
      await incR();
      await supabase.from("error_reports").insert({ business_id:business.id,error_type:"ai_timeout",context:{message:messageText},message:aiErr.message }).catch(()=>{});
    }
  }
}

// GET /webhook/whatsapp — Meta verification
app.get("/webhook/whatsapp", (req, res) => {
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if (mode==="subscribe"&&token===process.env.WA_VERIFY_TOKEN) { console.log("✅ Webhook verified!"); return res.status(200).send(challenge); }
  return res.sendStatus(403);
});

// POST /webhook/whatsapp — Incoming messages
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body?.object||body.object!=="whatsapp_business_account") return;
    const entry=body.entry?.[0], changes=entry?.changes?.[0], value=changes?.value, messages=value?.messages;
    if (!messages?.length) return;

    const msg             = messages[0];
    const fromPhone       = msg.from;
    const messageText     = msg.text?.body?.trim()||"";
    const waPhoneNumberId = value?.metadata?.phone_number_id;
    const contactName     = value?.contacts?.[0]?.profile?.name||fromPhone;

    if (!messageText||!fromPhone) return;
    console.log(`📨 From ${fromPhone}: "${messageText}"`);

    // Try to find business by THEIR OWN WhatsApp number (individual number mode)
    const { data: individualSettings } = await supabase.from("business_settings").select("*, businesses(*)").eq("wa_phone_id", waPhoneNumberId).single();

    if (individualSettings?.businesses) {
      // INDIVIDUAL NUMBER MODE — subscriber has their own number
      const biz = individualSettings.businesses;
      const tok = individualSettings.wa_access_token||process.env.WA_ACCESS_TOKEN;
      await handleBotMessage(fromPhone, messageText, contactName, biz, individualSettings, waPhoneNumberId, tok);
      return;
    }

    // SHARED NUMBER MODE — route by @username shortcode or session
    const platformPhoneId = process.env.WA_PHONE_NUMBER_ID||process.env.WA_PHONE_ID;
    const platformToken   = process.env.WA_ACCESS_TOKEN;

    // Check existing session
    const existingSession = sharedSessions.get(fromPhone);
    if (existingSession&&new Date(existingSession.expiresAt)>new Date()) {
      // Allow switching
      if (/^(switch|change|exit|back|main menu|go back)$/i.test(messageText)) {
        sharedSessions.delete(fromPhone);
        await sendWA(platformPhoneId, platformToken, fromPhone, `✅ Disconnected. Type *hi* to browse businesses or type *@username* to connect to one!`);
        return;
      }
      const { data: sharedBiz } = await supabase.from("businesses").select("*").eq("id", existingSession.businessId).single();
      if (sharedBiz) {
        const { data: sharedSettings } = await supabase.from("business_settings").select("*").eq("business_id", sharedBiz.id).single();
        existingSession.expiresAt = new Date(Date.now()+SESSION_MS).toISOString();
        sharedSessions.set(fromPhone, existingSession);
        await handleBotMessage(fromPhone, messageText, contactName, sharedBiz, sharedSettings, platformPhoneId, platformToken);
        return;
      }
    }

    // Check shortcode (@username)
    const shortcodeMatch = messageText.match(/^@([A-Za-z0-9_-]{2,30})$/);
    if (shortcodeMatch) {
      const code = shortcodeMatch[1].toLowerCase();
      const { data: biz } = await supabase.from("businesses").select("*").or(`username.eq.${code},referral_code.ilike.${code}`).eq("is_active", true).single();
      if (biz) {
        sharedSessions.set(fromPhone, { businessId:biz.id, businessName:biz.business_name, expiresAt:new Date(Date.now()+SESSION_MS).toISOString() });
        await sendWA(platformPhoneId, platformToken, fromPhone, `✅ *Welcome to ${biz.business_name}!* 🎉\n\nYou are now connected to their AI assistant.\nType *MENU* for options or *CATALOG* to see their products!\n\n_Type SWITCH to connect to a different business_`);
        return;
      }
    }

    // Show platform directory for new visitors
    const greetingTest = /^(hi|hello|hey|good morning|good evening|start|help|menu)$/i.test(messageText)||messageText.length<4;
    if (greetingTest) {
      const { data: bizList } = await supabase.from("businesses").select("username,business_name,business_category").eq("is_active", true).not("business_name","is",null).order("referral_count",{ascending:false}).limit(8);
      let dirMsg = `👋 *Welcome to VendrAI Marketplace!*\n\nConnect with any of our businesses:\n\n`;
      const catEmojis = { fashion:"👗",food:"🍔",tech:"💻",beauty:"✨",health:"💊",services:"🔧",education:"📚",agric:"🌾",other:"🏪" };
      (bizList||[]).forEach(b => { dirMsg += `${catEmojis[b.business_category]||"🏪"} *${b.business_name}*\n   Type: *@${b.username}*\n\n`; });
      dirMsg += `💡 Type *@businessname* to connect!\nExample: *@amarafashion*`;
      await sendWA(platformPhoneId, platformToken, fromPhone, dirMsg);
      return;
    }

    // Try to match business name from message
    const { data: nameMatch } = await supabase.from("businesses").select("*").eq("is_active", true).ilike("business_name",`%${messageText}%`).limit(1).single();
    if (nameMatch) {
      sharedSessions.set(fromPhone, { businessId:nameMatch.id, businessName:nameMatch.business_name, expiresAt:new Date(Date.now()+SESSION_MS).toISOString() });
      await sendWA(platformPhoneId, platformToken, fromPhone, `✅ *Welcome to ${nameMatch.business_name}!*\n\nType *MENU* for options!`);
      return;
    }

    // Default — show directory
    await sendWA(platformPhoneId, platformToken, fromPhone, `Type *@businessname* to connect to a business, or type *hi* to see our full directory! 😊`);

  } catch(err) { console.error("💥 Webhook error:", err.message); }
});

// ============================================================
// PAYSTACK WEBHOOK — Payment confirmation
// ============================================================

app.post("/webhook/paystack", async (req, res) => {
  try {
    const sig  = req.headers["x-paystack-signature"];
    const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY||"").update(req.body).digest("hex");
    if (hash!==sig) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString());
    console.log(`💳 Paystack: ${event.event}`);
    if (event.event==="charge.success") {
      const meta=event.data.metadata, orderId=meta?.order_id, bizId=meta?.business_id, phone=meta?.contact_phone;
      if (!orderId) return res.sendStatus(200);
      await supabase.from("orders").update({ paystack_status:"success",paystack_ref:event.data.reference,paid_at:new Date().toISOString(),status:"paid",updated_at:new Date().toISOString() }).eq("id", orderId);
      await supabase.from("payments").insert({ business_id:bizId,order_id:orderId,type:"order",amount:event.data.amount/100,currency:event.data.currency,paystack_ref:event.data.reference,paystack_txn_id:String(event.data.id),status:"success" }).catch(()=>{});
      if (phone) {
        const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
        if (order?.delivery_type==="digital"&&!order.digital_sent) {
          const { data: bizSettings } = await supabase.from("business_settings").select("*").eq("business_id", bizId).single();
          if (bizSettings) {
            let msg=`🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} paid!\n\n📥 *Your Product:*\n`;
            for (const item of (order.items||[])) {
              const { data: p } = await supabase.from("products").select("digital_link,digital_code").eq("id", item.product_id).single();
              if (p?.digital_link) msg+=`🔗 Download: ${p.digital_link}\n`;
              if (p?.digital_code) msg+=`🔑 Code: ${p.digital_code}\n`;
            }
            msg+=`\nThank you! 🙏 Type MENU to shop again.`;
            const tok=bizSettings.wa_access_token||process.env.WA_ACCESS_TOKEN;
            await sendWA(bizSettings.wa_phone_id||process.env.WA_PHONE_NUMBER_ID, tok, phone, msg);
            await supabase.from("orders").update({ digital_sent:true,digital_sent_at:new Date().toISOString(),status:"delivered" }).eq("id", orderId);
          }
        }
        if (order) {
          const { data: c } = await supabase.from("contacts").select("*").eq("business_id", bizId).eq("phone", phone).single();
          if (c) await supabase.from("contacts").update({ total_orders:c.total_orders+1,total_spent:Number(c.total_spent)+Number(order.total) }).eq("id", c.id).catch(()=>{});
        }
        // Notify subscriber their payment was confirmed
        notifySubscriber(bizId, `💰 *Payment Received!*\n\nOrder ${orderId.substring(0,8).toUpperCase()} paid via Paystack.\nAmount: ${event.data.currency} ${event.data.amount/100}`).catch(()=>{});
      }
    }
    res.sendStatus(200);
  } catch(err) { console.error("💥 Paystack error:", err.message); res.sendStatus(500); }
});

// ============================================================
// ADMIN PANEL — Founder-only routes
// ============================================================

app.get("/admin/all-businesses", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { data, error } = await supabase.from("businesses").select("id,username,business_name,plan,reply_count,reply_limit,created_at,is_active,email_verified").order("created_at",{ascending:false});
    if (error) throw error;
    const { data: orders } = await supabase.from("orders").select("business_id");
    const counts = {};
    (orders||[]).forEach(o=>{ counts[o.business_id]=(counts[o.business_id]||0)+1; });
    res.json({ success:true, businesses:(data||[]).map(b=>({...b,total_orders:counts[b.id]||0})), total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/platform-stats", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { count: bizCount }   = await supabase.from("businesses").select("id",{count:"exact",head:true});
    const { count: orderCount } = await supabase.from("orders").select("id",{count:"exact",head:true});
    const { count: contactCount } = await supabase.from("contacts").select("id",{count:"exact",head:true});
    const { data: revData }     = await supabase.from("orders").select("total").eq("paystack_status","success");
    const totalRevenue = (revData||[]).reduce((s,o)=>s+Number(o.total||0), 0);
    res.json({ success:true, stats:{ total_businesses:bizCount||0, total_orders:orderCount||0, total_contacts:contactCount||0, total_revenue:totalRevenue } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/set-plan", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { plan, businessId } = req.body;
    if (!PLAN_LIMITS[plan]) return res.status(400).json({ error:"Invalid plan." });
    await supabase.from("businesses").update({ plan, reply_limit:PLAN_LIMITS[plan].reply_limit, updated_at:new Date().toISOString() }).eq("id", businessId||req.business.id);
    res.json({ success:true, message:`✅ Plan set to ${plan}`, plan });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/suspend-business", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { businessId, reason, suspend } = req.body;
    await supabase.from("businesses").update({ is_suspended:suspend!==false, suspension_reason:reason||"Suspended by admin", updated_at:new Date().toISOString() }).eq("id", businessId);
    res.json({ success:true, message:`Business ${suspend!==false?"suspended":"reactivated"}.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/test-message", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { phone, message } = req.body;
    if (!phone||!message) return res.status(400).json({ error:"Phone and message required." });
    const phoneId = process.env.WA_PHONE_NUMBER_ID||process.env.WA_PHONE_ID;
    const token   = process.env.WA_ACCESS_TOKEN;
    if (!phoneId||!token) return res.status(400).json({ error:"WhatsApp not configured." });
    const result = await sendWA(phoneId, token, phone, message);
    res.json(result.success ? { success:true, messageId:result.messageId } : { success:false, error:result.error });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/global-kb", requireAuth, async (req, res) => {
  try {
    if (!getAdmins().includes(req.business.username)) return res.status(403).json({ error:"Admin only." });
    const { data, error } = await supabase.from("global_kb_library").select("*").order("uses",{ascending:false});
    if (error) throw error;
    res.json({ success:true, keywords:data, total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status:    "✅ VendrAI v3.1 is running",
    version:   "3.1.0",
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    env:       process.env.NODE_ENV||"production",
    features:  ["multi-tenant","auth","otp-email","otp-whatsapp","shared-number","individual-number","product-edit","admin-panel","payment-flex","bank-opay-palmpay","global-kb","100-templates","ai-self-healing","message-queue","paystack"],
    queue:     msgQueue.stats,
  });
});

app.get("/", (req, res) => {
  res.json({ app:"VendrAI", version:"3.1.0", status:"🟢 Live", tagline:"AI WhatsApp Automation for African SMEs" });
});

app.use((req,res) => res.status(404).json({ error:"Route not found", path:req.path }));
app.use((err,req,res,next) => { console.error("💥", err.message); res.status(500).json({ error:"Internal server error" }); });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 VendrAI v3.1 running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`💬 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`⚡ Features: Auth+OTP+SharedNumber+Admin+PaymentFlex+GlobalKB`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV||"production"}\n`);
});

module.exports = app;
