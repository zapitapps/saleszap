// ============================================================
// SalesZap Backend — index.js COMPLETE v3.2.0
// ALL FEATURES INCLUDED — NO PATCHES NEEDED
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
// PLAN LIMITS (SalesZap Pricing)
// ============================================================
const PLAN_LIMITS = {
  free:    { reply_limit:70,     product_limit:5,    contact_limit:70,    broadcast_limit:0,    kb_limit:20,   ai_enabled:true, broadcasts_enabled:false, analytics:false, excel_import:false, remove_watermark:false },
  starter: { reply_limit:1000,   product_limit:50,   contact_limit:1000,  broadcast_limit:250,  kb_limit:200,  ai_enabled:true, broadcasts_enabled:true,  analytics:true,  excel_import:false, remove_watermark:true  },
  growth:  { reply_limit:5000,   product_limit:300,  contact_limit:10000, broadcast_limit:1000, kb_limit:1000, ai_enabled:true, broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
  pro:     { reply_limit:999999, product_limit:9999, contact_limit:99999, broadcast_limit:9999, kb_limit:9999, ai_enabled:true, broadcasts_enabled:true,  analytics:true,  excel_import:true,  remove_watermark:true  },
};

const PLAN_PRICES_NGN = { starter: 5999, growth: 14999, pro: 34999 };

// ─── BRANDING ──────────────────────────────────────────────
const APP_NAME = "SalesZap";
const WATERMARK = `\n\n_Powered by SalesZap_ ⚡ | ${process.env.FRONTEND_URL || "https://zapitapps.github.io/saleszap"}`;
const TAGLINE = "The WhatsApp Commerce OS for African SMEs";
const HF_MODEL  = "Qwen/Qwen2.5-72B-Instruct";
const HF_API    = "https://router.huggingface.co/v1/chat/completions";
// ─── BSP PROVIDER CONFIG ──────────────────────────────────────
const BSP_PROVIDER = process.env.BSP_PROVIDER || '360dialog';
const BSP_API_KEY = process.env.BSP_API_KEY || '';
const BSP_BASE_URL = process.env.BSP_BASE_URL || 'https://api.360dialog.com/v1';
// ============================================================
// MESSAGE QUEUE (60 msg/sec)
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

// Shared number sessions
const sharedSessions = new Map();
const pendingOrders  = new Map();
const processedMessages = new Map();
const inboundTextDedupe = new Map();
const SESSION_MS     = 60 * 60 * 1000;
const MESSAGE_DEDUPE_MS = 10 * 60 * 1000;
const TEXT_DEDUPE_MS    = 25 * 1000;
const PENDING_ORDER_MS  = 30 * 60 * 1000;
const OTP_TTL_MINUTES  = 10;

// ============================================================
// UTILITIES
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ignoreDb(query, label = "db") {
  try { return await query; }
  catch(e) { console.warn(`⚠️ Ignored ${label} error:`, e.message); return null; }
}

function hashPw(pw) {
  return crypto.createHash("sha256").update(pw + (process.env.ADMIN_SECRET_TOKEN || "saleszap")).digest("hex");
}
function genOTP()   { return Math.floor(100000 + Math.random() * 900000).toString(); }
function genToken() { return crypto.randomBytes(32).toString("hex"); }
function genRef()   { return "SZX-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }

function listEnv(name) {
  return (process.env[name] || "").split(",").map(u => u.trim().toLowerCase()).filter(Boolean);
}

function getAdmins() {
  return Array.from(new Set([
    ...listEnv("ADMIN_USERNAMES"),
    ...listEnv("ADMIN_OWNER_USERNAMES"),
    ...listEnv("ADMIN_STAFF_USERNAMES"),
    ...listEnv("ADMIN_LIMITED_USERNAMES"),
  ])).filter(Boolean);
}

const ADMIN_PERMISSIONS = {
  owner:   ["view_subscribers","manage_subscribers","delete_subscribers","set_plan","view_stats","test_message","manage_staff"],
  manager: ["view_subscribers","manage_subscribers","set_plan","view_stats","test_message"],
  support: ["view_subscribers","view_stats","test_message"],
  viewer:  ["view_subscribers","view_stats"],
};

async function getAdminRole(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return null;
  if (listEnv("ADMIN_OWNER_USERNAMES").includes(u) || listEnv("ADMIN_USERNAMES").includes(u)) return "owner";
  if (listEnv("ADMIN_STAFF_USERNAMES").includes(u)) return "manager";
  if (listEnv("ADMIN_LIMITED_USERNAMES").includes(u)) return "support";

  try {
    const { data } = await supabase.from("admin_staff").select("role,is_active").eq("username", u).single();
    if (data?.is_active !== false && ADMIN_PERMISSIONS[data?.role]) return data.role;
  } catch(e) {}
  return null;
}

async function requireAdminPermission(req, res, permission) {
  const role = await getAdminRole(req.business?.username);
  if (!role) {
    res.status(403).json({ error:"Admin only." });
    return null;
  }
  const permissions = ADMIN_PERMISSIONS[role] || [];
  if (!permissions.includes(permission)) {
    res.status(403).json({ error:"You do not have permission for this action.", role, required:permission });
    return null;
  }
  return { role, permissions };
}

async function logAdminAction(req, action, targetType, targetId, details = {}) {
  try {
    await supabase.from("admin_audit_logs").insert({
      admin_business_id: req.business?.id || null,
      admin_username: req.business?.username || "unknown",
      action,
      target_type: targetType,
      target_id: targetId || null,
      details,
      ip_address: req.headers["x-forwarded-for"] || req.ip || null,
      user_agent: req.headers["user-agent"] || null,
      created_at: new Date().toISOString(),
    });
  } catch(e) {}
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
  const t = String(text || "").toLowerCase().trim();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|howdy)$/i.test(t)) return "greeting";
  if (/^(menu|help|start|options?)$/i.test(t)) return "menu";
  if (/^(catalog|products?|shop|browse|list)$/i.test(t)) return "product";
  if (/^(price|how much|cost|rate|naira)$/i.test(t) || /\b(price|how much|cost|rate)\b/i.test(t)) return "price";
  if (/^(order\b|buy\b|purchase\b)/i.test(t) || /\b(place\s+an?\s+order|place\s+order|checkout|proceed|confirm\s+order)\b/i.test(t)) return "order";
  if (/^(yes|ok|okay|confirm|proceed|go ahead|place it|create it|make it)$/i.test(t)) return "confirm";
  if (/\b(track|status|where is|my order)\b/i.test(t)) return "track";
  if (/\b(pay|payment|bank|transfer|card|account number|opay|palmpay|kuda)\b/i.test(t)) return "payment";
  if (/\b(deliver|delivery|ship|shipping|how long|location)\b/i.test(t)) return "delivery";
  if (/\b(contact|phone|call|human|agent|support)\b/i.test(t)) return "contact";
  if (/\b(cancel|return|refund|stop|not interested)\b/i.test(t)) return "cancel";
  return "general";
}

function normalizeIncomingText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sanitizeAIResponse(text) {
  let out = String(text || "").trim();
  out = out.replace(/(?:^|\n).*\b(your order is on (?:the way|its way)|order has been (?:created|placed|confirmed|shipped)|payment (?:confirmed|received)|we are preparing your order)\b.*$/gim, "").trim();
  out = out.replace(/(?:^|\n)\s*(?:type\s+menu\s+for\s+options.*|i am not sure about that.*)$/gim, "").trim();
  return out;
}

function detectCustomerMood(text) {
  const t = normalizeIncomingText(text);
  if (/\b(stop|not interested|remove me|don't message|dont message|leave me|unsubscribe)\b/i.test(t)) return "not_interested";
  if (/\b(angry|annoyed|upset|bad service|scam|fraud|fake|cheat|complain|complaint|rubbish|nonsense)\b/i.test(t)) return "angry";
  if (/\b(refund|return|cancel|damaged|broken|wrong item|not received|where is my order)\b/i.test(t)) return "support_needed";
  if (/\b(expensive|too costly|last price|discount|reduce|can you do)\b/i.test(t)) return "price_sensitive";
  if (/\b(i want|i need|buy|order|pay|checkout|send account|available)\b/i.test(t)) return "buying_signal";
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)$/i.test(t)) return "greeting";
  return "neutral";
}

function shouldHumanHandoff(text) {
  const mood = detectCustomerMood(text);
  return ["angry", "support_needed"].includes(mood) || /\b(human|agent|manager|owner|call me|speak to someone)\b/i.test(text);
}

function buildPremiumGreeting(business, lang = "en") {
  const name = business.business_name || "our shop";
  const base = `Hello 👋 Welcome to *${name}* on SalesZap!`;

  if (lang === "pidgin") {
    return `${base}\n\nWetin you dey find? I fit help you with price, order, delivery or payment. Wetin you want make I do for you today?`;
  }
  if (lang === "yo") {
    return `${base}\n\nẸ ń lẹ́! Kini o n wa? Mo le ran ọ lọwọ pẹlu ọja, owo, gbigbe tabi sisanwo. Kini o fẹ ki n ṣe fun ọ loni?`;
  }
  if (lang === "ha") {
    return `${base}\n\nSannu! Me ka ke nema? Zan iya taimaka maka da farashi, oda, jigilar kaya ko biya. Me kake so in yi maka yau?`;
  }
  if (lang === "ig") {
    return `${base}\n\nNdewo! Kedu ihe ị na-achọ? Enwere m ike inyere gị aka na ngwaahịa, ego, nnyefe ma ọ bụ ịkwụ ụgwọ. Gịnị ka ị chọrọ ka m mee maka gị taa?`;
  }
  return `${base}\n\nI can help with products, prices, delivery, payment, or placing an order. What would you like to do today?`;
}

function buildHumanHandoffMessage(business, text) {
  const ph = business.contact_phone || business.phone || "";
  const email = business.contact_email || "";
  const mood = detectCustomerMood(text);
  let msg = mood === "angry"
    ? `I’m sorry about this. Let’s sort it properly.`
    : `I understand. This needs careful attention.`;
  msg += `\n\nA team member from *${business.business_name}* should assist you directly.`;
  if (ph) msg += `\n📞 Phone: ${ph}`;
  if (email) msg += `\n📧 Email: ${email}`;
  msg += `\n\nPlease share your order number or details, and we’ll help you from there.`;
  return msg;
}

function buildNotInterestedMessage(business) {
  return `No problem at all. Thanks for your time 🙏\n\nI won’t push. If you ever need *${business.business_name}* on SalesZap, just send a message here anytime.`;
}

function fuzzy(text, kw) {
  const tw = text.toLowerCase().split(/\s+/);
  const kws = kw.toLowerCase().split(/\s+/);
  return kws.filter(k => tw.some(t => t.includes(k)||k.includes(t))).length / kws.length;
}

// ============================================================
// OTP RELIABILITY HELPERS
// ============================================================
function maskEmail(email) {
  const e = String(email || "");
  const [name, domain] = e.split("@");
  if (!domain) return e ? "***" : "";
  return `${name.slice(0,2)}***@${domain}`;
}

function otpExpiryDate() {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

async function saveOTPRecord(identifier, type, otp) {
  const payload = {
    identifier: String(identifier || "").toLowerCase(),
    type,
    otp_code: otp,
    expires_at: otpExpiryDate().toISOString(),
  };
  let { error } = await supabase.from("otp_verifications").insert(payload);
  if (error && String(error.message || "").toLowerCase().includes("expires_at")) {
    const fallback = { identifier: payload.identifier, type, otp_code: otp };
    const retry = await supabase.from("otp_verifications").insert(fallback);
    error = retry.error;
  }
  if (error) throw error;
}

async function logOTPDelivery({ identifier, type, channel, status, provider, error, messageId }) {
  try {
    await supabase.from("otp_delivery_logs").insert({
      identifier: String(identifier || "").toLowerCase(),
      masked_identifier: identifier && String(identifier).includes("@") ? maskEmail(identifier) : String(identifier || "").replace(/.(?=.{4})/g, "*"),
      type,
      channel,
      provider,
      status,
      error_message: error ? String(error).substring(0,500) : null,
      message_id: messageId || null,
      created_at: new Date().toISOString(),
    });
  } catch(e) {}
}

function brevoConfigStatus() {
  const key = process.env.BREVO_API_KEY || "";
  const sender = process.env.BREVO_SENDER_EMAIL || "";
  return {
    apiKeyPresent: !!key,
    apiKeyLooksValid: /^xkeysib-/i.test(key.trim()),
    apiKeyLength: key ? key.trim().length : 0,
    senderPresent: !!sender,
    senderEmail: sender || null,
  };
}

async function verifyBrevoAccount() {
  const key = process.env.BREVO_API_KEY;
  if (!key) return { success:false, status:null, error:"BREVO_API_KEY is missing" };
  try {
    const r = await axios.get("https://api.brevo.com/v3/account", {
      headers:{ "api-key":key, "Content-Type":"application/json" },
      timeout:10000,
    });
    return { success:true, status:r.status, email:r.data?.email || null, companyName:r.data?.companyName || null };
  } catch(err) {
    return { success:false, status:err.response?.status || null, error:err.response?.data?.message || err.message };
  }
}

// ============================================================
// OTP EMAIL — Brevo + WhatsApp fallback
// ============================================================
async function sendOTPEmail(email, otp, type = "email_verify") {
  console.log(`📧 OTP for ${email}: ${otp} [${type}]`);

  const BREVO = process.env.BREVO_API_KEY;
  if (!BREVO) {
    console.warn("⚠️ BREVO_API_KEY not set — OTP only in logs");
    await logOTPDelivery({ identifier:email, type, channel:"email", provider:"brevo", status:"failed", error:"BREVO_API_KEY not set" });
    return false;
  }
  if (!/^xkeysib-/i.test(BREVO.trim())) {
    console.warn("⚠️ BREVO_API_KEY does not look like a Brevo API key");
  }

  const subjects = {
    email_verify:   `SalesZap — Your verification code: ${otp}`,
    password_reset: `SalesZap — Reset your password: ${otp}`,
  };

  const html = `<div style="font-family:Arial,sans-serif;background:#0B0F1A;color:#E2E8F0;padding:30px;border-radius:16px;max-width:480px;margin:0 auto;">
    <div style="text-align:center;margin-bottom:20px;">
      <div style="background:linear-gradient(135deg,#25D366,#128C7E);width:48px;height:48px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;">⚡</div>
      <h2 style="color:#25D366;margin:8px 0 4px;">SalesZap</h2>
      <p style="color:#64748B;font-size:.82rem;margin:0;">The WhatsApp Commerce OS for African SMEs</p>
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
      sender:      { name: "SalesZap", email: process.env.BREVO_SENDER_EMAIL || "noreply@saleszap.app" },
      to:          [{ email }],
      subject:     subjects[type] || `SalesZap Code: ${otp}`,
      htmlContent: html,
    }, {
      headers: { "api-key": BREVO, "Content-Type": "application/json" },
      timeout: 10000,
    });
    console.log(`✅ Email sent to ${email} via Brevo`);
    await logOTPDelivery({ identifier:email, type, channel:"email", provider:"brevo", status:"sent" });
    return true;
  } catch(err) {
    const msg = err.response?.data?.message || err.message;
    console.error("❌ Brevo failed:", msg);
    await logOTPDelivery({ identifier:email, type, channel:"email", provider:"brevo", status:"failed", error:msg });
    return false;
  }
}

async function sendOTPWhatsApp(phone, otp, type = "email_verify") {
  const phoneId = process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token || !/^\+[1-9]\d{7,14}$/.test(phone)) return false;
  const msgs = {
    email_verify:   `⚡ *SalesZap Verification*\n\nYour verification code:\n\n*${otp}*\n\nExpires in 10 minutes. Do not share.`,
    password_reset: `🔑 *SalesZap Password Reset*\n\nYour reset code:\n\n*${otp}*\n\nExpires in 10 minutes.`,
  };
  try {
    const result = await sendWA(phoneId, token, phone, msgs[type] || msgs.email_verify);
    if (result?.success) {
      console.log(`✅ WhatsApp OTP sent to ${phone}`);
      await logOTPDelivery({ identifier:phone, type, channel:"whatsapp", provider:"meta", status:"sent", messageId:result.messageId });
      return true;
    }
    const errMsg = result?.error || "WhatsApp send failed";
    console.error("❌ WA OTP failed:", errMsg);
    await logOTPDelivery({ identifier:phone, type, channel:"whatsapp", provider:"meta", status:"failed", error:errMsg });
    return false;
  } catch(err) {
    console.error("❌ WA OTP failed:", err.message);
    await logOTPDelivery({ identifier:phone, type, channel:"whatsapp", provider:"meta", status:"failed", error:err.message });
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
// ─── BSP CONNECT WHATSAPP ──────────────────────────────────────
async function connectWhatsAppViaBSP(businessId, phoneNumber, redirectUrl) {
  if (!BSP_API_KEY) {
    return { 
      success: false, 
      error: 'BSP_API_KEY not configured. Please add it to Render environment variables.' 
    };
  }

  try {
    // Different BSPs have different APIs – we'll use 360dialog as the primary
    let payload = {
      phoneNumber: phoneNumber,
      redirectUrl: redirectUrl || `${process.env.FRONTEND_URL}/dashboard.html?whatsapp=connected`
    };

    let endpoint = `${BSP_BASE_URL}/whatsapp/connect`;
    
    // For 360dialog – they use a different endpoint for embedded signup
    if (BSP_PROVIDER === '360dialog') {
      // 360dialog uses a redirect-based flow with a session token
      // We'll generate a session token and store it
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await supabase.from('whatsapp_connections').insert({
        business_id: businessId,
        phone_number: phoneNumber,
        session_token: sessionToken,
        status: 'pending',
        created_at: new Date().toISOString()
      });
      
      // Build the 360dialog embedded signup URL
      // Note: You'll need to get the actual endpoint from 360dialog docs
      const signupUrl = `${BSP_BASE_URL}/embed/signup?phone=${phoneNumber}&session=${sessionToken}&callback=${encodeURIComponent(process.env.BACKEND_URL + '/webhook/bsp/callback')}`;
      
      return {
        success: true,
        method: 'redirect',
        redirectUrl: signupUrl,
        sessionToken: sessionToken,
        message: 'Click the link to connect your WhatsApp number via 360dialog.'
      };
    }

    // For other BSPs (Twilio, MessageBird, etc.)
    const response = await axios.post(endpoint, payload, {
      headers: {
        'Authorization': `Bearer ${BSP_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return {
      success: true,
      method: 'api',
      data: response.data
    };

  } catch (error) {
    console.error('BSP connect error:', error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
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
  const biz = session.businesses;
  const envAdmin = getAdmins().includes(String(biz?.username||"").toLowerCase());
  if (!envAdmin && (biz?.is_active === false || biz?.is_suspended === true)) {
    return res.status(403).json({ error: "This account has been disabled. Please contact SalesZap support." });
  }
  await supabase.from("sessions").update({ last_used_at: new Date().toISOString() }).eq("id", session.id);
  req.business = biz;
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
    const { username, email, phone, password, businessName, referralCode, businessCategory, businessDesc, city, state } = req.body;
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
      business_name: businessName, 
      business_category: businessCategory || "general",
      business_desc: businessDesc || null,
      city: city || null,
      state: state || null,
      whatsapp_number: phone,
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

    // Auto seed sample data
    try {
      await seedSampleDataForBusiness(biz.id);
    } catch (e) {
      console.warn("Auto-seed failed (non-fatal):", e.message);
    }

    const otp = genOTP();
    await saveOTPRecord(email.toLowerCase(), "email_verify", otp);
    const emailSent = await sendOTPEmail(email.toLowerCase(), otp, "email_verify");
    const whatsappSent = emailSent ? false : await sendOTPWhatsApp(phone, otp, "email_verify");

    const sessionToken = genToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });

    res.status(201).json({
      success: true,
      message: emailSent
        ? "✅ Account created! Check your email for verification code."
        : whatsappSent
          ? "✅ Account created! Check your WhatsApp for verification code."
          : "✅ Account created, but OTP delivery failed. Please click Resend OTP or contact support.",
      session_token: sessionToken,
      otp_delivery: emailSent ? "email" : (whatsappSent ? "whatsapp" : "failed"),
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
    const envAdmin = getAdmins().includes(String(biz.username||"").toLowerCase());
    if (!envAdmin && (biz.is_active === false || biz.is_suspended === true)) {
      return res.status(403).json({ error: "This account has been disabled. Please contact SalesZap support." });
    }
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
    await saveOTPRecord(req.business.email, "email_verify", otp);
    const emailSent = await sendOTPEmail(req.business.email, otp, "email_verify");
    const whatsappSent = emailSent ? false : await sendOTPWhatsApp(req.business.phone, otp, "email_verify");
    res.json({ success: emailSent || whatsappSent, delivery: emailSent ? "email" : (whatsappSent ? "whatsapp" : "failed"), message: emailSent ? "✅ Code sent to your email!" : (whatsappSent ? "✅ Code sent to your WhatsApp!" : "❌ OTP delivery failed. Check Brevo/WhatsApp settings.") });
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
    await saveOTPRecord(email.toLowerCase(), "password_reset", otp);
    const emailSent = await sendOTPEmail(email.toLowerCase(), otp, "password_reset");
    const whatsappSent = emailSent ? false : (biz.phone ? await sendOTPWhatsApp(biz.phone, otp, "password_reset") : false);
    res.json({ success: emailSent || whatsappSent, delivery: emailSent ? "email" : (whatsappSent ? "whatsapp" : "failed"), message: emailSent ? "✅ Reset code sent to your email." : (whatsappSent ? "✅ Reset code sent to your WhatsApp." : "❌ Reset code delivery failed. Please contact support.") });
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
    const updates = { updated_at:new Date().toISOString() };
    if (waPhoneId) updates.wa_phone_id = waPhoneId;
    if (waAccessToken) updates.wa_access_token = waAccessToken;
    if (waBusinessId) updates.wa_business_id = waBusinessId;
    if (paystackPublic) updates.paystack_public = paystackPublic;
    if (paystackSecret) updates.paystack_secret = paystackSecret;

    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ error: "Enter at least one WhatsApp or Paystack value to save." });
    }

    await supabase.from("business_settings").update(updates).eq("business_id", req.business.id);
    const saved = [];
    if (waPhoneId || waAccessToken || waBusinessId) saved.push("WhatsApp");
    if (paystackPublic || paystackSecret) saved.push("Paystack");
    res.json({ success: true, message: `✅ ${saved.join(" & ")} settings saved!` });
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
// PRODUCTS API
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

app.patch("/api/products/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","description","category","price","sale_price","currency","type","stock","digital_link","digital_code","image_url","keywords","tags","sku","is_active","is_featured","salePrice"];
    const updates = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
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
// ============================================================

app.get("/payment-methods/:businessId", async (req, res) => {
  try {
    const { data: settings } = await supabase.from("business_settings")
      .select("paystack_secret,bank_details").eq("business_id", req.params.businessId).single();
    const methods = [];
    if (settings?.paystack_secret) methods.push({ id:"paystack", name:"Card / Bank Transfer / USSD", icon:"💳", type:"auto", note:"Instant confirmation via Paystack" });
    const bd = settings?.bank_details || {};
    const accounts = Array.isArray(bd.bank_accounts)&&bd.bank_accounts.length ? bd.bank_accounts : (bd.bank_name&&bd.account_number ? [{ bank_name:bd.bank_name, account_number:bd.account_number, account_name:bd.account_name }] : []);
    accounts.forEach((a,i)=>methods.push({ id:`bank_transfer_${i+1}`, name:`Bank Transfer (${a.bank_name})`, icon:"🏦", type:"manual", details:{ bank:a.bank_name, account:a.account_number, name:a.account_name } }));
    if (bd.opay_number)       methods.push({ id:"opay",       name:"OPay",       icon:"📱", type:"manual", details:{ number:bd.opay_number,       name:bd.account_name } });
    if (bd.palmpay_number)    methods.push({ id:"palmpay",    name:"PalmPay",    icon:"📱", type:"manual", details:{ number:bd.palmpay_number,    name:bd.account_name } });
    if (bd.kuda_number)       methods.push({ id:"kuda",       name:"Kuda Bank",  icon:"🏦", type:"manual", details:{ number:bd.kuda_number,       name:bd.account_name } });
    if (bd.moniepoint_number) methods.push({ id:"moniepoint", name:"Moniepoint", icon:"💰", type:"manual", details:{ number:bd.moniepoint_number, name:bd.account_name } });
    if (bd.cash_on_delivery)  methods.push({ id:"cash",       name:"Cash on Delivery", icon:"💵", type:"manual", details:{ note:bd.cod_note||"Pay when you receive your item" } });
    if (!methods.length) methods.push({ id:"contact", name:"Contact Business Directly", icon:"📞", type:"manual", details:{ note:"Message us to arrange payment" } });
    res.json({ success:true, methods, hasPaystack:!!settings?.paystack_secret });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const {
      bankName,accountNumber,accountName,opayNumber,palmpayNumber,kudaNumber,moniepointNumber,
      cashOnDelivery,codNote,bankAccounts,otherMethods,paymentInstructions
    } = req.body;
    const bankDetails = {};

    const cleanAccounts = Array.isArray(bankAccounts) ? bankAccounts
      .map(a => ({ bank_name:String(a.bank_name||a.bankName||"").trim(), account_number:String(a.account_number||a.accountNumber||"").trim(), account_name:String(a.account_name||a.accountName||"").trim() }))
      .filter(a => a.bank_name && a.account_number) : [];
    if (cleanAccounts.length) {
      bankDetails.bank_accounts = cleanAccounts.slice(0,5);
      bankDetails.bank_name = cleanAccounts[0].bank_name;
      bankDetails.account_number = cleanAccounts[0].account_number;
      bankDetails.account_name = cleanAccounts[0].account_name;
    } else {
      if (bankName)      bankDetails.bank_name      = bankName;
      if (accountNumber) bankDetails.account_number = accountNumber;
      if (accountName)   bankDetails.account_name   = accountName;
    }

    if (opayNumber)       bankDetails.opay_number        = opayNumber;
    if (palmpayNumber)    bankDetails.palmpay_number     = palmpayNumber;
    if (kudaNumber)       bankDetails.kuda_number        = kudaNumber;
    if (moniepointNumber) bankDetails.moniepoint_number  = moniepointNumber;
    if (cashOnDelivery!==undefined) bankDetails.cash_on_delivery = !!cashOnDelivery;
    if (codNote)          bankDetails.cod_note           = codNote;
    if (paymentInstructions) bankDetails.payment_instructions = String(paymentInstructions).substring(0,500);
    if (Array.isArray(otherMethods)) bankDetails.other_methods = otherMethods.map(m => ({ name:String(m.name||"").trim(), details:String(m.details||"").trim() })).filter(m => m.name && m.details).slice(0,5);

    await supabase.from("business_settings").update({ bank_details:bankDetails, updated_at:new Date().toISOString() }).eq("business_id", req.business.id);
    res.json({ success:true, message:"✅ Payment details saved! Customers can now pay via Paystack and/or your manual payment details.", bankDetails });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/dashboard/bank-details", requireAuth, async (req, res) => {
  try {
    const { data } = await supabase.from("business_settings").select("bank_details,paystack_public,paystack_secret").eq("business_id", req.business.id).single();
    res.json({ success:true, bankDetails:data?.bank_details||{}, hasPaystack:!!(data?.paystack_secret), paystackPublic:data?.paystack_public||"" });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /dashboard/orders/:id/confirm-payment
app.post("/dashboard/orders/:id/confirm-payment", requireAuth, async (req, res) => {
  try {
    const { paymentMethod, reference, amountReceived, note } = req.body;
    const { data: order } = await supabase
      .from("orders")
      .select("*, contacts(phone, name)")
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .single();
    if (!order) return res.status(404).json({ error: "Order not found." });

    const deliveryDays = req.business.delivery_days || "2-5";

    await supabase.from("orders").update({
      status: "processing",
      paystack_status: "success",
      paystack_ref: reference || `MANUAL-${Date.now()}`,
      paid_at: new Date().toISOString(),
      payment_method: paymentMethod || "manual",
      notes: note || `Manual payment confirmed via ${paymentMethod || "bank"}`,
      updated_at: new Date().toISOString()
    }).eq("id", req.params.id);

    // AUTO-NOTIFY CUSTOMER
    const { data: bizSettings } = await supabase
      .from("business_settings")
      .select("*")
      .eq("business_id", req.business.id)
      .single();
    const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID;

    if (order.contacts?.phone && tok && phoneId) {
      let msg = `🎉 *Payment Confirmed!*\n\n`;
      msg += `✅ Your order *${order.order_number}* has been confirmed and is now being processed.\n\n`;
      msg += `📦 *Items:*\n`;
      for (const item of (order.items || [])) {
        msg += `• ${item.name || "Item"} × ${item.qty || 1} — ${order.currency} ${Number(item.price || 0).toLocaleString()}\n`;
      }
      msg += `\n🚚 *Estimated delivery:* ${deliveryDays} days\n`;
      msg += `📍 We'll update you when your order ships.\n\n`;
      msg += `Thank you for shopping with us! 🙏\n`;
      msg += `Reply *TRACK ${order.order_number}* anytime for status.`;

      if (order.delivery_type === "digital" && !order.digital_sent) {
        msg = `🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} paid!\n\n📥 *Your Product:*\n`;
        for (const item of (order.items || [])) {
          const { data: p } = await supabase
            .from("products")
            .select("digital_link,digital_code")
            .eq("id", item.product_id)
            .single();
          if (p?.digital_link) msg += `🔗 Download: ${p.digital_link}\n`;
          if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
        }
        msg += `\nThank you! 🙏 Type MENU to shop again.`;
        await supabase.from("orders").update({
          digital_sent: true,
          digital_sent_at: new Date().toISOString(),
          status: "delivered"
        }).eq("id", req.params.id);
      }

      await sendWA(phoneId, tok, order.contacts.phone, msg);
    }

    notifySubscriber(req.business.id,
      `💳 *Payment Confirmed!*\n\nOrder: ${order.order_number}\nAmount: ${order.currency} ${Number(order.total).toLocaleString()}\nCustomer: ${order.contacts?.name || order.contacts?.phone || "Unknown"}\n\nReady to ship! 🚚`
    );

    res.json({
      success: true,
      message: "✅ Payment confirmed! Customer has been automatically notified."
    });
  } catch (err) {
    console.error("confirm-payment error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscribe
app.post("/api/subscribe", requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLAN_PRICES_NGN[plan]) return res.status(400).json({ error:"Invalid plan. Choose: starter, growth, or pro." });
    const platformPaystackKey = process.env.PAYSTACK_SECRET_KEY || "";
    if (!platformPaystackKey) return res.status(500).json({ error:"Platform Paystack is not configured. Add PAYSTACK_SECRET_KEY in Render." });
    if (!/^sk_(live|test)_/i.test(platformPaystackKey.trim())) return res.status(500).json({ error:"Platform Paystack secret key is invalid. Use a key that starts with sk_live_ or sk_test_." });
    const response = await axios.post("https://api.paystack.co/transaction/initialize",
      { email:req.business.email, amount:PLAN_PRICES_NGN[plan]*100, currency:"NGN",
        reference:`SUB-${req.business.id.substring(0,8)}-${Date.now()}`,
        metadata:{ business_id:req.business.id, plan, type:"subscription", username:req.business.username },
        callback_url:`${process.env.FRONTEND_URL}/dashboard.html?upgraded=1` },
      { headers:{ Authorization:`Bearer ${platformPaystackKey}` } }
    );
    res.json({ success:true, paymentLink:response.data?.data?.authorization_url, plan, amount:`₦${PLAN_PRICES_NGN[plan].toLocaleString()}/month` });
  } catch(err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: /invalid key/i.test(msg) ? "Platform Paystack secret key is invalid in Render. Replace PAYSTACK_SECRET_KEY with a valid sk_live_ or sk_test_ key." : msg });
  }
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

app.patch("/dashboard/kb/:id", requireAuth, async (req, res) => {
  try {
    const { keyword, answer, category, language, isActive } = req.body;
    const updates = { updated_at:new Date().toISOString() };
    if (keyword !== undefined) updates.keyword = String(keyword).trim();
    if (answer !== undefined) updates.answer = String(answer).trim();
    if (category !== undefined) updates.category = category || "general";
    if (language !== undefined) updates.language = language || "en";
    if (isActive !== undefined) updates.is_active = !!isActive;
    if (updates.keyword === "" || updates.answer === "") return res.status(400).json({ error:"Keyword and answer cannot be empty." });
    const { data, error } = await supabase.from("knowledge_base").update(updates).eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error:"KB entry not found." });
    res.json({ success:true, entry:data, message:"✅ KB entry updated." });
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
    let q = supabase.from("orders").select("*, contacts(name,phone)", {count:"exact"}).eq("business_id", req.business.id).order("created_at",{ascending:false}).range((page-1)*limit, page*limit-1);
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

// ============================================================
// FULL LIFECYCLE ROUTES
// ============================================================

app.post("/dashboard/orders/:id/mark-shipped", requireAuth, async (req, res) => {
  try {
    const { trackingNumber } = req.body;
    const { data: order } = await supabase
      .from("orders")
      .select("*, contacts(phone, name)")
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .single();
    if (!order) return res.status(404).json({ error: "Order not found." });

    const deliveryDays = req.business.delivery_days || "2-5";
    const tracking = trackingNumber || order.tracking_number || "Will be updated soon";

    await supabase.from("orders").update({
      status: "shipped",
      tracking_number: tracking,
      shipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", req.params.id);

    const { data: bizSettings } = await supabase
      .from("business_settings")
      .select("*")
      .eq("business_id", req.business.id)
      .single();
    const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID;

    if (order.contacts?.phone && tok && phoneId) {
      let msg = `📦 *Your Order is on the Way!*\n\n`;
      msg += `🆔 *${order.order_number}*\n`;
      msg += `📍 Tracking: *${tracking}*\n`;
      msg += `🚚 Expected delivery in ${deliveryDays} business days.\n\n`;
      msg += `Reply *TRACK ${order.order_number}* anytime for updates.`;
      msg += `\n\n_Thank you for shopping with us! 🙏_`;
      await sendWA(phoneId, tok, order.contacts.phone, msg);
    }

    const deliveryCheckDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await supabase.from("scheduled_tasks").insert({
      business_id: req.business.id,
      order_id: req.params.id,
      task_type: "delivery_confirmation",
      scheduled_at: deliveryCheckDate.toISOString(),
      status: "pending"
    });

    res.json({
      success: true,
      message: "✅ Order marked shipped. Customer notified. Delivery confirmation scheduled."
    });
  } catch (err) {
    console.error("mark-shipped error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/dashboard/orders/:id/mark-delivered", requireAuth, async (req, res) => {
  try {
    const { data: order } = await supabase
      .from("orders")
      .select("*, contacts(phone, name)")
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .single();
    if (!order) return res.status(404).json({ error: "Order not found." });

    await supabase.from("orders").update({
      status: "delivered",
      delivered_at: new Date().toISOString(),
      delivery_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", req.params.id);

    const { data: bizSettings } = await supabase
      .from("business_settings")
      .select("*")
      .eq("business_id", req.business.id)
      .single();
    const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID;

    if (order.contacts?.phone && tok && phoneId) {
      let msg = `✅ *Order Delivered!*\n\n`;
      msg += `🆔 *${order.order_number}*\n`;
      msg += `We hope you love your purchase! 💝\n\n`;
      msg += `⭐ *How was your experience?*\n`;
      msg += `Please reply with a rating 1-5:\n`;
      msg += `1 = Needs improvement\n`;
      msg += `5 = Excellent! 🌟\n\n`;
      msg += `💬 *Feedback (optional):* Tell us what we can do better.`;
      msg += `\n\n_Thank you for supporting our small business! 🙏_`;
      await sendWA(phoneId, tok, order.contacts.phone, msg);

      await supabase.from("orders").update({
        satisfaction_requested_at: new Date().toISOString()
      }).eq("id", req.params.id);
    }

    res.json({
      success: true,
      message: "✅ Marked delivered. Satisfaction survey sent."
    });
  } catch (err) {
    console.error("mark-delivered error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders/:id/reorder", requireAuth, async (req, res) => {
  try {
    const { data: originalOrder } = await supabase
      .from("orders")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .single();
    if (!originalOrder) return res.status(404).json({ error: "Order not found." });

    const newOrder = await createOrderAndSendPayment({
      fromPhone: req.business.phone,
      contact: { id: originalOrder.contact_id },
      business: req.business,
      settings: {},
      phoneId: process.env.WA_PHONE_NUMBER_ID,
      token: process.env.WA_ACCESS_TOKEN,
      wrap: (t) => t,
      product: originalOrder.items[0],
      sourceMessage: "REORDER"
    });

    await supabase.from("orders").update({
      reordered_from: originalOrder.id
    }).eq("id", newOrder.id);

    res.json({
      success: true,
      message: "🔄 Reorder created!",
      newOrder
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// BROADCASTS, REFERRALS, SETTINGS
// ============================================================

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
// GLOBAL KB
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
// SHARED NUMBER
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
// WHATSAPP WEBHOOK
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

// ─── AI PROVIDER SWITCH ──────────────────────────────────────
async function callAI(message, biz, lang, intent, settings, conversationMemory = "") {
  const provider = process.env.AI_MODEL_PROVIDER || 'hf';
  const systemPrompt = `You are SalesZap, the most advanced AI sales assistant in Africa. You work for "${biz.business_name}" – a leading business in ${biz.city || "Nigeria"}.

Your mission: Make every customer feel like a VIP, guide them smoothly to purchase, and leave them delighted.

Core Personality:
- Warm, professional, and highly empathetic – like a top-tier sales consultant.
- Speak naturally, like a friendly Nigerian professional (use light Pidgin only if the customer does).
- Be concise but never robotic. Use 1–2 relevant emojis max.
- Always sound premium, confident, and trustworthy.

Business Context:
- Business: ${biz.business_desc || "Quality products and services"}
- Location: ${biz.city || ""} ${biz.country || "Nigeria"}
- Delivery: Usually ${biz.delivery_days || "1-3 days"}. Fee: ${biz.currency || "NGN"} ${biz.delivery_fee || 0}
${settings?.custom_instructions ? `Special instructions: ${settings.custom_instructions}` : ""}

${conversationMemory ? `Customer memory (from this conversation only):
${conversationMemory}
` : ""}

CRITICAL RULES (NEVER BREAK):
1. NEVER claim an order is placed/confirmed/paid/shipped – only the system does that.
2. NEVER make up prices, stock, or delivery times.
3. ALWAYS guide the customer toward a specific action: CATALOG, ORDER [product], PAYMENT.
4. Answer ONLY the latest question – do not repeat offers unless asked.
5. Keep replies under 85 words – short and punchy.
6. If unsure, say "Let me check that for you" and offer human help.

Current customer intent: ${intent}
Language tone: ${lang === "pidgin" ? "Nigerian Pidgin" : lang === "yo" ? "Yoruba-friendly English" : lang === "ha" ? "Hausa-friendly English" : lang === "ig" ? "Igbo-friendly English" : "Natural English"}

Be excellent. Make every reply feel like a personal concierge.`;

  const start = Date.now();

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (!key) throw new Error('OPENAI_API_KEY not set');
    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 150,
        temperature: 0.7,
      }, {
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const text = r.data.choices?.[0]?.message?.content || '';
      if (!text) throw new Error('Empty response from OpenAI');
      return { text, latency: Date.now() - start };
    } catch (e) {
      throw new Error(`OpenAI API error: ${e.message}`);
    }
  }

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model,
        max_tokens: 150,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }]
      }, {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      const text = r.data.content?.[0]?.text || '';
      if (!text) throw new Error('Empty response from Claude');
      return { text, latency: Date.now() - start };
    } catch (e) {
      throw new Error(`Anthropic API error: ${e.message}`);
    }
  }

  // Default: Hugging Face (Qwen)
  return callQwen(message, biz, lang, intent, settings, conversationMemory);
}

// ─── QWEN (Hugging Face) ─────────────────────────────────────
async function callQwen(message, biz, lang, intent, settings, conversationMemory = "") {
  const HF_TOKEN = process.env.HF_API_KEY;
  if (!HF_TOKEN) throw new Error("HF_API_KEY not set in Render environment");

  const sys = `You are SalesZap, the most advanced AI sales assistant in Africa. You work for "${biz.business_name}" – a leading business in ${biz.city || "Nigeria"}.

Your mission: Make every customer feel like a VIP, guide them smoothly to purchase, and leave them delighted.

Core Personality:
- Warm, professional, and highly empathetic – like a top-tier sales consultant.
- Speak naturally, like a friendly Nigerian professional (use light Pidgin only if the customer does).
- Be concise but never robotic. Use 1–2 relevant emojis max.
- Always sound premium, confident, and trustworthy.

Business Context:
- Business: ${biz.business_desc || "Quality products and services"}
- Location: ${biz.city || ""} ${biz.country || "Nigeria"}
- Delivery: Usually ${biz.delivery_days || "1-3 days"}. Fee: ${biz.currency || "NGN"} ${biz.delivery_fee || 0}
${settings?.custom_instructions ? `Special instructions: ${settings.custom_instructions}` : ""}

${conversationMemory ? `Customer memory (from this conversation only):
${conversationMemory}
` : ""}

CRITICAL RULES (NEVER BREAK):
1. NEVER claim an order is placed/confirmed/paid/shipped – only the system does that.
2. NEVER make up prices, stock, or delivery times.
3. ALWAYS guide the customer toward a specific action: CATALOG, ORDER [product], PAYMENT.
4. Answer ONLY the latest question – do not repeat offers unless asked.
5. Keep replies under 85 words – short and punchy.
6. If unsure, say "Let me check that for you" and offer human help.

Current customer intent: ${intent}
Language tone: ${lang === "pidgin" ? "Nigerian Pidgin" : lang === "yo" ? "Yoruba-friendly English" : lang === "ha" ? "Hausa-friendly English" : lang === "ig" ? "Igbo-friendly English" : "Natural English"}

Be excellent. Make every reply feel like a personal concierge.`;

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

// ─── HELPER FUNCTIONS FOR BOT ──────────────────────────────
function cleanOrderQuery(message) {
  const raw = String(message || "").trim();
  let q = raw
    .replace(/^order\s*\((.+)\)$/i, "$1")
    .replace(/^order\s*[:\-]?\s*/i, "")
    .replace(/^(buy|purchase)\s+/i, "")
    .replace(/^(i\s+want\s+to\s+buy|i\s+want|i\s+need|i'll\s+take|ill\s+take|give\s+me|get\s+me)\s+/i, "")
    .replace(/\b(please|pls|now|today)\b/gi, "")
    .trim();
  if (/^(placed|place|confirm|proceed|go ahead|yes|ok|okay|create|make)\b/i.test(q)) return "";
  return q;
}

function productMatchScore(query, product) {
  const q = String(query || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = String(product?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const desc = String(product?.description || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!q || !name) return 0;
  if (name.includes(q) || q.includes(name)) return 1;
  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const hay = `${name} ${desc}`;
  let hits = 0;
  for (const w of qWords) if (hay.includes(w)) hits++;
  const wordScore = hits / Math.max(qWords.length, 1);
  return Math.max(wordScore, fuzzy(q, name), fuzzy(q, `${name} ${desc}`));
}

async function findBestProduct(businessId, query) {
  const { data: prods } = await supabase.from("products").select("*").eq("business_id", businessId).eq("is_active", true);
  if (!prods?.length) return { product:null, products:[], score:0 };
  let best = null, bestScore = 0;
  for (const p of prods) {
    const score = productMatchScore(query, p);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { product: bestScore >= 0.45 ? best : null, products:prods, score:bestScore };
}

function pendingKey(fromPhone, businessId) {
  return `${businessId}:${fromPhone}`;
}

function rememberPendingProduct(fromPhone, businessId, product) {
  if (!product?.id) return;
  pendingOrders.set(pendingKey(fromPhone, businessId), {
    productId: product.id,
    productName: product.name,
    expiresAt: Date.now() + PENDING_ORDER_MS,
  });
}

async function getPendingProduct(fromPhone, businessId) {
  const key = pendingKey(fromPhone, businessId);
  const pending = pendingOrders.get(key);
  if (!pending || pending.expiresAt < Date.now()) { pendingOrders.delete(key); return null; }
  const { data: product } = await supabase.from("products").select("*").eq("business_id", businessId).eq("id", pending.productId).eq("is_active", true).single();
  return product || null;
}

function calculateLeadTemperature(intent, mood, message) {
  const t = normalizeIncomingText(message);
  if (mood === "not_interested") return "not_interested";
  if (mood === "angry" || mood === "support_needed") return "support_needed";
  if (intent === "order" || intent === "confirm" || /\b(pay|checkout|send account|available now|i want|i need|buy)\b/i.test(t)) return "hot";
  if (intent === "price" || intent === "product" || /\b(price|how much|discount|delivery|available)\b/i.test(t)) return "warm";
  if (intent === "contact" || intent === "payment") return "warm";
  return "cold";
}

function mergeLeadTemperature(oldTemp, newTemp) {
  const rank = { not_interested:0, cold:1, support_needed:2, warm:3, hot:4 };
  if (!oldTemp) return newTemp;
  if (newTemp === "not_interested") return "not_interested";
  if (newTemp === "support_needed") return "support_needed";
  return (rank[newTemp] || 1) >= (rank[oldTemp] || 1) ? newTemp : oldTemp;
}

async function getOrCreateConversationSession({ business, contact, fromPhone, contactName }) {
  try {
    const { data: existing } = await supabase.from("conversation_sessions")
      .select("*")
      .eq("business_id", business.id)
      .eq("contact_phone", fromPhone)
      .eq("is_active", true)
      .order("updated_at", { ascending:false })
      .limit(1)
      .single();
    if (existing) return existing;

    const { data: created } = await supabase.from("conversation_sessions").insert({
      business_id: business.id,
      contact_id: contact?.id || null,
      contact_phone: fromPhone,
      contact_name: contactName || fromPhone,
      current_intent: "new",
      lead_temperature: "cold",
      handoff_status: "bot_active",
      message_count: 0,
      is_active: true,
    }).select().single();
    return created || null;
  } catch(e) {
    return null;
  }
}

async function updateConversationSession(sessionId, updates) {
  if (!sessionId) return;
  try {
    await supabase.from("conversation_sessions").update({
      ...updates,
      updated_at: new Date().toISOString(),
    }).eq("id", sessionId);
  } catch(e) {}
}

async function logConversationEvent(session, payload) {
  if (!session?.id) return;
  try {
    await supabase.from("conversation_events").insert({
      session_id: session.id,
      business_id: session.business_id,
      contact_id: session.contact_id || null,
      contact_phone: session.contact_phone,
      direction: payload.direction || "inbound",
      event_type: payload.event_type || "message",
      message_text: payload.message_text || null,
      intent: payload.intent || null,
      mood: payload.mood || null,
      lead_temperature: payload.lead_temperature || null,
      product_id: payload.product_id || null,
      product_name: payload.product_name || null,
      order_id: payload.order_id || null,
      ai_used: !!payload.ai_used,
      kb_hit: !!payload.kb_hit,
      metadata: payload.metadata || {},
    });
  } catch(e) {}
}

async function recordCustomerIntent(session, payload) {
  if (!session?.id) return;
  try {
    await supabase.from("customer_intents").insert({
      session_id: session.id,
      business_id: session.business_id,
      contact_phone: session.contact_phone,
      intent: payload.intent,
      mood: payload.mood,
      lead_temperature: payload.lead_temperature,
      message_text: payload.message_text,
      product_name: payload.product_name || null,
      confidence: payload.confidence || 0.75,
      source: "whatsapp",
    });
  } catch(e) {}
}

async function getConversationMemory(session) {
  if (!session?.id) return "";
  try {
    const { data: recent } = await supabase.from("conversation_events")
      .select("direction,event_type,message_text,intent,product_name,lead_temperature,created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending:false })
      .limit(6);
    const events = (recent || []).reverse().map(e => `${e.direction}: ${String(e.message_text || e.event_type || "").substring(0,120)}`).join("\n");
    return `Conversation memory:\nLead temperature: ${session.lead_temperature || "cold"}\nHandoff status: ${session.handoff_status || "bot_active"}\nLast product: ${session.last_product_discussed || "none"}\nLast order: ${session.last_order_id || "none"}\nRecent messages:\n${events}`.substring(0,1200);
  } catch(e) { return ""; }
}

async function learnFromConversation(session, insight) {
  if (!session?.id) return;
  try {
    await supabase.from("conversation_learnings").insert({
      business_id: session.business_id,
      session_id: session.id,
      contact_phone_hash: crypto.createHash("sha256").update(String(session.contact_phone||"")).digest("hex"),
      learning_type: insight.learning_type || "intent_pattern",
      title: insight.title || null,
      content: insight.content || null,
      intent: insight.intent || null,
      product_name: insight.product_name || null,
      lead_temperature: insight.lead_temperature || null,
      is_global_candidate: !!insight.is_global_candidate,
      metadata: insight.metadata || {},
    });
  } catch(e) {}
}

function deriveLeadStage(intent, temperature, mood) {
  if (mood === "not_interested" || temperature === "not_interested") return "not_interested";
  if (intent === "order" || intent === "confirm") return "hot";
  if (intent === "payment") return "negotiating";
  if (intent === "price" || intent === "product") return "interested";
  if (temperature === "hot") return "hot";
  if (temperature === "warm") return "interested";
  return "new";
}

function nextFollowupDateForStage(stage, temperature) {
  if (["not_interested","won","paid"].includes(stage) || temperature === "not_interested") return null;
  const hours = temperature === "hot" ? 6 : temperature === "warm" ? 24 : 72;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function upsertLeadFromConversation({ business, contact, fromPhone, contactName, intent, mood, leadTemperature, messageText, productName, orderId }) {
  try {
    const stage = deriveLeadStage(intent, leadTemperature, mood);
    const status = stage === "not_interested" ? "not_interested" : "active";
    const nextFollowupAt = nextFollowupDateForStage(stage, leadTemperature);
    const payload = {
      business_id: business.id,
      contact_id: contact?.id || null,
      contact_phone: fromPhone,
      name: contactName || contact?.name || fromPhone,
      source: "whatsapp",
      stage,
      temperature: leadTemperature || "cold",
      status,
      last_intent: intent,
      last_message: String(messageText || "").substring(0, 1000),
      last_product_discussed: productName || null,
      last_order_id: orderId || null,
      next_followup_at: nextFollowupAt,
      followup_stop_reason: stage === "not_interested" ? "Customer said not interested/stop" : null,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabase.from("leads").select("id,stage,temperature,followup_day").eq("business_id", business.id).eq("contact_phone", fromPhone).single();
    let lead;
    if (existing) {
      const mergedTemp = mergeLeadTemperature(existing.temperature, payload.temperature);
      const mergedStage = stage === "new" && existing.stage ? existing.stage : stage;
      const { data } = await supabase.from("leads").update({ ...payload, temperature:mergedTemp, stage:mergedStage }).eq("id", existing.id).select().single();
      lead = data;
      if (existing.stage !== mergedStage) await ignoreDb(supabase.from("lead_activities").insert({ lead_id:existing.id,business_id:business.id,activity_type:"stage_change",title:"Stage changed",old_stage:existing.stage,new_stage:mergedStage,details:messageText,created_by:"bot" }), "lead stage activity");
    } else {
      const { data } = await supabase.from("leads").insert(payload).select().single();
      lead = data;
      if (lead?.id) await ignoreDb(supabase.from("lead_activities").insert({ lead_id:lead.id,business_id:business.id,activity_type:"created",title:"Lead created from WhatsApp",details:messageText,created_by:"bot" }), "lead created activity");
    }
    if (lead?.id && nextFollowupAt && status === "active") {
      await ignoreDb(supabase.from("lead_followups").insert({ lead_id:lead.id,business_id:business.id,day_number:1,due_at:nextFollowupAt,message_suggestion:"Follow up warmly. Ask if they still need help and mention the product they asked about." }), "lead followup create");
    }
    return lead || null;
  } catch(e) {
    console.warn("⚠️ Lead upsert skipped:", e.message);
    return null;
  }
}

function manualPaymentLines(bd = {}, currency = "NGN") {
  let msg = "";
  const accounts = Array.isArray(bd.bank_accounts) && bd.bank_accounts.length
    ? bd.bank_accounts
    : (bd.bank_name && bd.account_number ? [{ bank_name:bd.bank_name, account_number:bd.account_number, account_name:bd.account_name }] : []);
  accounts.slice(0,5).forEach((a, i) => {
    msg += `🏦 *Bank Transfer ${accounts.length>1?i+1:""}*\n   Bank: ${a.bank_name}\n   Account: ${a.account_number}\n   Name: ${a.account_name||""}\n`;
  });
  if (bd.opay_number) msg += `📱 *OPay:* ${bd.opay_number}${bd.account_name?` (${bd.account_name})`:""}\n`;
  if (bd.palmpay_number) msg += `📱 *PalmPay:* ${bd.palmpay_number}${bd.account_name?` (${bd.account_name})`:""}\n`;
  if (bd.kuda_number) msg += `🏦 *Kuda:* ${bd.kuda_number}${bd.account_name?` (${bd.account_name})`:""}\n`;
  if (bd.moniepoint_number) msg += `💰 *Moniepoint:* ${bd.moniepoint_number}${bd.account_name?` (${bd.account_name})`:""}\n`;
  if (Array.isArray(bd.other_methods)) bd.other_methods.slice(0,5).forEach(m => { msg += `💳 *${m.name}:* ${m.details}\n`; });
  if (bd.cash_on_delivery) msg += `💵 *Cash on Delivery* available${bd.cod_note?`: ${bd.cod_note}`:""}\n`;
  if (bd.payment_instructions) msg += `📝 ${bd.payment_instructions}\n`;
  return msg;
}

async function findRecentOrderForCustomer(businessId, contactId, phone, preferredOrderId = null) {
  try {
    if (preferredOrderId) {
      const { data } = await supabase.from("orders").select("*").eq("business_id", businessId).eq("id", preferredOrderId).single();
      if (data) return data;
    }
    let q = supabase.from("orders").select("*").eq("business_id", businessId).order("created_at", { ascending:false }).limit(1);
    if (contactId) q = q.eq("contact_id", contactId);
    const { data } = await q.single();
    return data || null;
  } catch(e) { return null; }
}

async function buildPaymentForExistingOrder(order, business, fromPhone) {
  const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret,bank_details").eq("business_id", business.id).single();
  const currency = order.currency || business.currency || "NGN";
  let paymentLink = order.payment_link || "";

  if (!paymentLink && bizSettings?.paystack_secret && order.status !== "paid" && order.paystack_status !== "success") {
    try {
      const reference = order.paystack_ref || `VND-${order.id.substring(0,8).toUpperCase()}`;
      const resp = await axios.post("https://api.paystack.co/transaction/initialize",
        { email:`${String(fromPhone).replace("+","")}@vendrai.app`, amount:Math.round(Number(order.total||0)*100), currency,
          reference,
          metadata:{ order_id:order.id,business_id:business.id,contact_phone:fromPhone,order_number:order.order_number },
          callback_url:`${process.env.BACKEND_URL}/webhook/paystack/verify?reference=${encodeURIComponent(reference)}` },
        { headers:{ Authorization:`Bearer ${bizSettings.paystack_secret}`,"Content-Type":"application/json" } }
      );
      paymentLink = resp.data?.data?.authorization_url || "";
      if (paymentLink) await ignoreDb(supabase.from("orders").update({ payment_link:paymentLink, paystack_ref:reference }).eq("id", order.id), "save regenerated payment link");
    } catch(e) { console.error("Paystack regenerate link error:", e.response?.data || e.message); }
  }

  let msg = `💳 *Payment for Order ${order.order_number}*\n\n`;
  msg += `💵 Total: *${currency} ${Number(order.total||0).toLocaleString()}*\n`;
  if (order.paystack_status === "success" || order.status === "paid") {
    msg += `✅ This order is already marked as paid.`;
    return msg;
  }
  if (paymentLink) {
    msg += `👇 Pay securely here:\n${paymentLink}\n\n⚡ Payment confirms automatically after successful payment.`;
    return msg;
  }

  const bd = bizSettings?.bank_details || {};
  msg += `Online payment link is not configured yet for this business.\n\n`;
  msg += `*Manual payment options:*\n`;
  const manual = manualPaymentLines(bd, currency);
  msg += manual || `📞 Please contact the business for payment details.\n`;
  msg += `\nAfter payment, send proof here.`;
  return msg;
}

async function createOrderAndSendPayment({ fromPhone, contact, business, settings, phoneId, token, wrap, product, sourceMessage }) {
  const price       = Number(product.sale_price || product.price || 0);
  const deliveryFee = product.type === "digital" ? 0 : Number(business.delivery_fee || 0);
  const total       = price + deliveryFee;
  const currency    = product.currency || business.currency || "NGN";
  const { data: order, error: orderErr } = await supabase.from("orders").insert({
    business_id:business.id,
    contact_id:contact?.id || null,
    order_number:`ORD-${Date.now().toString(36).toUpperCase()}`,
    items:[{ product_id:product.id,name:product.name,qty:1,price,currency }],
    subtotal:price,
    delivery_fee:deliveryFee,
    total,
    currency,
    delivery_type:product.type,
    status:"pending",
  }).select().single();
  if (orderErr) throw orderErr;

  const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret,bank_details,paystack_public").eq("business_id", business.id).single();
  let orderMsg = `✅ *Order Created!*\n\n📦 *${product.name}*\n💰 Item: ${currency} ${Number(price).toLocaleString()}\n🚚 Delivery: ${currency} ${Number(deliveryFee).toLocaleString()}\n💵 *Total: ${currency} ${Number(total).toLocaleString()}*\n🆔 *${order.order_number}*\n\n`;

  let payLink = "";
  if (bizSettings?.paystack_secret) {
    try {
      const reference = `VND-${order.id.substring(0,8).toUpperCase()}`;
      const resp = await axios.post("https://api.paystack.co/transaction/initialize",
        { email:`${fromPhone.replace("+","")}@vendrai.app`,amount:Math.round(total*100),currency,
          reference,
          metadata:{ order_id:order.id,business_id:business.id,contact_phone:fromPhone,order_number:order.order_number },
          callback_url:`${process.env.BACKEND_URL}/webhook/paystack/verify?reference=${encodeURIComponent(reference)}` },
        { headers:{ Authorization:`Bearer ${bizSettings.paystack_secret}`,"Content-Type":"application/json" } }
      );
      payLink = resp.data?.data?.authorization_url || "";
      if (payLink) await supabase.from("orders").update({ payment_link:payLink, paystack_ref:reference }).eq("id", order.id);
    } catch(e) {
      console.error("Paystack initialize error:", e.response?.data || e.message);
    }
  }

  if (payLink) {
    orderMsg += `👇 *Pay securely here:*\n${payLink}\n\n⚡ Payment confirms automatically after successful payment.`;
  } else {
    const bd = bizSettings?.bank_details || {};
    orderMsg += `💳 *How to Pay:*\n`;
    const manual = manualPaymentLines(bd, currency);
    orderMsg += manual || `📞 Please contact us for payment details.\n`;
    orderMsg += `\nAfter payment, send proof here. We confirm within 30 minutes.`;
  }

  pendingOrders.delete(pendingKey(fromPhone, business.id));
  await sendWA(phoneId, token, fromPhone, wrap(orderMsg));
  notifySubscriber(business.id,
    `🛍️ *New Order!*\n\n📦 ${product.name}\n💰 ${currency} ${Number(total).toLocaleString()}\n📱 From: ${fromPhone}\n🆔 ${order.order_number}\n${payLink?`🔗 Payment link sent\n`:""}\nLogin to confirm: ${process.env.FRONTEND_URL}/dashboard.html`
  ).catch(()=>{});
  await ignoreDb(supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:sourceMessage,ai_response:orderMsg,kb_hit:false,status:"success",confidence:1.0 }), "order ai log");
  return order;
}

async function recordPaymentProof({ business, contact, fromPhone, order, media, messageText }) {
  try {
    const payload = {
      business_id: business.id,
      contact_id: contact?.id || null,
      contact_phone: fromPhone,
      order_id: order?.id || null,
      order_number: order?.order_number || null,
      proof_type: media?.mediaType || "text",
      media_id: media?.mediaId || null,
      mime_type: media?.mimeType || null,
      sha256: media?.sha256 || null,
      caption: media?.caption || null,
      message_text: messageText || null,
      status: "pending_review",
      created_at: new Date().toISOString(),
    };
    const { data } = await supabase.from("payment_proofs").insert(payload).select().single();
    if (order?.id) {
      await ignoreDb(supabase.from("orders").update({ status:"payment_proof_received", payment_proof_received:true, updated_at:new Date().toISOString() }).eq("id", order.id), "mark payment proof received");
    }
    return data || null;
  } catch(e) {
    console.warn("⚠️ Payment proof log skipped:", e.message);
    return null;
  }
}

function looksLikePaymentProof(messageText, media = {}) {
  const t = normalizeIncomingText(messageText);
  return !!media?.mediaId || /\b(paid|payment sent|sent proof|receipt|transfer receipt|i have paid|i paid|proof|transaction id|session id)\b/i.test(t);
}

// ─── MAIN BOT HANDLER ────────────────────────────────────────
async function handleBotMessage(fromPhone, messageText, contactName, business, settings, phoneId, token, incomingMeta = {}) {
  const plan       = business.plan||"free";
  const planLimits = PLAN_LIMITS[plan]||PLAN_LIMITS.free;
  const addWM      = !planLimits.remove_watermark;
  const wrap       = t => addWM ? t+WATERMARK : t;
  const used       = business.reply_count||0;
  const limit      = business.reply_limit||100;

  if (plan!=="pro"&&used>=limit) {
    await sendWA(phoneId, token, fromPhone, `⚠️ This business has reached its Freemium/monthly reply limit. Please contact them directly, or ask the business to upgrade SalesZap for faster automated replies: ${process.env.FRONTEND_URL || "https://zapitapps.github.io/saleszap"}/pricing.html`);
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
  const mood    = detectCustomerMood(messageText);
  const leadTemperature = calculateLeadTemperature(intent, mood, messageText);
  const conversationSession = await getOrCreateConversationSession({ business, contact, fromPhone, contactName });
  const sessionLeadTemperature = mergeLeadTemperature(conversationSession?.lead_temperature, leadTemperature);
  if (conversationSession?.id) {
    await updateConversationSession(conversationSession.id, {
      current_intent: intent,
      lead_temperature: sessionLeadTemperature,
      handoff_status: mood === "not_interested" ? "not_interested" : (shouldHumanHandoff(messageText) ? "needs_human" : (conversationSession.handoff_status || "bot_active")),
      message_count: (conversationSession.message_count || 0) + 1,
      last_message_at: new Date().toISOString(),
    });
    conversationSession.lead_temperature = sessionLeadTemperature;
    await logConversationEvent(conversationSession, { direction:"inbound", event_type:"customer_message", message_text:messageText, intent, mood, lead_temperature:sessionLeadTemperature });
    await recordCustomerIntent(conversationSession, { intent, mood, lead_temperature:sessionLeadTemperature, message_text:messageText });
  }
  let activeLead = await upsertLeadFromConversation({ business, contact, fromPhone, contactName, intent, mood, leadTemperature:sessionLeadTemperature, messageText });
  const incR    = () => supabase.from("businesses").update({ reply_count:used+1 }).eq("id", business.id);

  // ─── SEND TYPING INDICATOR ──────────────────────────────────
  async function sendTyping() {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: fromPhone,
          type: "reaction"
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
    } catch(e) {}
  }
  await sendTyping();

  // ─── PAYMENT PROOF HANDLING ──────────────────────────────────
  if (looksLikePaymentProof(messageText, incomingMeta)) {
    const recentOrder = await findRecentOrderForCustomer(business.id, contact?.id, fromPhone, conversationSession?.last_order_id || null);
    const proof = await recordPaymentProof({ business, contact, fromPhone, order:recentOrder, media:incomingMeta, messageText });
    if (conversationSession?.id) {
      await updateConversationSession(conversationSession.id, { current_intent:"payment_proof", handoff_status:"needs_human", last_order_id:recentOrder?.id || conversationSession.last_order_id || null });
      await logConversationEvent(conversationSession, { direction:"inbound", event_type:"payment_proof_received", message_text:messageText || incomingMeta.caption || "Payment proof media", intent:"payment", lead_temperature:"hot", order_id:recentOrder?.id || null, metadata:{ proof_id:proof?.id || null, media_type:incomingMeta.mediaType || null } });
    }
    const ack = recentOrder
      ? `✅ Payment proof received for order *${recentOrder.order_number}*.\n\nOur team will review it and confirm shortly. Please do not resend unless we ask for another proof.`
      : `✅ Payment proof received.\n\nPlease send your order number too, so our team can match the payment to the right order.`;
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(ack));
    let proofNotice = `💳 *Payment Proof Received*\n\nBusiness: ${business.business_name}\nCustomer: ${fromPhone}\n`;
    if (recentOrder) proofNotice += `Order: ${recentOrder.order_number}\nAmount: ${recentOrder.currency||business.currency||"NGN"} ${Number(recentOrder.total||0).toLocaleString()}\n`;
    else proofNotice += `Order: Not matched\n`;
    proofNotice += `Proof: ${incomingMeta.mediaType || "text"}\n\nOpen dashboard → Orders to review and confirm.`;
    notifySubscriber(business.id, proofNotice).catch(()=>{});
    await incR(); return;
  }

  // ─── RATING DETECTION (Step 7) ──────────────────────────────
  const ratingMatch = messageText.trim().match(/^rate\s*([1-5])(?:\s+(.+))?$/i);
  if (ratingMatch) {
    const rating = parseInt(ratingMatch[1]);
    const feedback = ratingMatch[2] || null;

    const { data: recentOrder } = await supabase
      .from("orders")
      .select("*")
      .eq("business_id", business.id)
      .eq("contact_id", contact?.id)
      .eq("status", "delivered")
      .is("satisfaction_rating", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (recentOrder) {
      await supabase.from("orders").update({
        satisfaction_rating: rating,
        satisfaction_feedback: feedback,
        satisfaction_completed: true,
        updated_at: new Date().toISOString()
      }).eq("id", recentOrder.id);

      let reply = `⭐ *Thank you for your rating!*\n\n`;
      reply += `You gave us ${rating}/5. `;
      if (rating >= 4) {
        reply += `We're so happy you loved your experience! ❤️\n\n`;
        reply += `Would you like to *REORDER* your last item? Just type REORDER to get it again!`;
      } else if (rating >= 3) {
        reply += `We appreciate your honest feedback and will work to improve. 🙏\n\n`;
        reply += `Is there anything specific we could do better?`;
      } else {
        reply += `We're sorry we didn't meet your expectations. 😔\n\n`;
        reply += `A team member will reach out to make things right.`;
      }
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(reply));

      notifySubscriber(business.id,
        `⭐ *New Rating*\n\nOrder: ${recentOrder.order_number}\nRating: ${rating}/5\nFeedback: ${feedback || "None provided"}\n\nLogin to view: ${process.env.FRONTEND_URL}/dashboard.html`
      );

      await incR();
      return;
    } else {
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(
        `I couldn't find a recent delivered order to rate. If you've received your order, please let us know which one! 🙏`
      ));
      await incR();
      return;
    }
  }

  // ─── PREMIUM CONVERSATION CONTROL ────────────────────────────
  if (mood === "not_interested") {
    pendingOrders.delete(pendingKey(fromPhone, business.id));
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(buildNotInterestedMessage(business)));
    await incR(); return;
  }

  if (shouldHumanHandoff(messageText) && intent !== "contact") {
    const handoff = buildHumanHandoffMessage(business, messageText);
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(handoff));
    notifySubscriber(business.id, `⚠️ *Customer needs support*\n\nBusiness: ${business.business_name}\nCustomer: ${fromPhone}\nMessage: ${messageText}\n\nPlease follow up quickly.`).catch(()=>{});
    await incR(); return;
  }

  if (mood === "greeting") {
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(buildPremiumGreeting(business, lang)));
    await incR(); return;
  }

  // ─── MENU ──────────────────────────────────────────────────────
  if (/^(menu|help|start|options?)$/i.test(messageText.trim())) {
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(`🤖 *${business.business_name} — Menu*\n\n🛍️ *CATALOG* — Browse products\n💰 *PRICE* — See prices\n📦 *TRACK [no]* — Track order\n📞 *CONTACT* — Our team\n🚀 *ORDER [name]* — Place order\n💳 *PAYMENT* — How to pay\n\nOr just ask me anything! 😊`));
    await incR(); return;
  }

  // ─── CATALOG/PRICE ────────────────────────────────────────────
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
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(cat));
    await incR(); return;
  }

  // ─── PAYMENT INFO ──────────────────────────────────────────────
  if (/^(payment|how to pay|pay|payment link|where is the payment link|send payment link|payment link please)$/i.test(messageText.trim()) || /\b(payment\s*link|pay\s*link|checkout\s*link)\b/i.test(messageText.trim())) {
    const recentOrder = await findRecentOrderForCustomer(business.id, contact?.id, fromPhone, conversationSession?.last_order_id || null);
    if (recentOrder) {
      const payMsg = await buildPaymentForExistingOrder(recentOrder, business, fromPhone);
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(payMsg));
      await incR(); return;
    }

    const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret,bank_details").eq("business_id", business.id).single();
    const bd = bizSettings?.bank_details||{};
    let payMsg = `💳 *Payment Options for ${business.business_name}*\n\n`;
    if (bizSettings?.paystack_secret) payMsg += `✅ Online checkout is available after you create an order.\n   Type *ORDER [product name]* to get your secure payment link.\n\n`;
    const manual = manualPaymentLines(bd, business.currency||"NGN");
    if (manual) payMsg += manual;
    if (!bizSettings?.paystack_secret && !manual) payMsg += `📞 Payment details are not configured yet. Type *CONTACT* to speak with the business.\n`;
    payMsg += `\nTo buy, type *ORDER [product name]*.`;
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(payMsg));
    await incR(); return;
  }

  // ─── CONTACT ──────────────────────────────────────────────────
  if (/^(contact|support|human|agent|talk)$/i.test(messageText.trim())) {
    const ph = business.contact_phone||business.phone;
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(`📞 *Contact ${business.business_name}*\n\nPhone: ${ph}\n${business.contact_email?`Email: ${business.contact_email}\n`:""}${business.city?`Location: ${business.city}\n`:""}\nWe respond within 2 hours! 😊`));
    await incR(); return;
  }

  // ─── DELIVERY ──────────────────────────────────────────────────
  if (/^(delivery|deliver|shipping|ship)$/i.test(messageText.trim())) {
    const areas = business.delivery_areas?.length ? business.delivery_areas.join(", ") : "Nationwide";
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(`📦 *Delivery Info*\n\n📍 Areas: ${areas}\n⏱️ Time: ${business.delivery_days||"1-3 business days"}\n💰 Fee: ${business.currency||"NGN"} ${Number(business.delivery_fee||0).toLocaleString()}${business.free_delivery_above?`\n🎁 FREE above ${business.currency||"NGN"} ${Number(business.free_delivery_above).toLocaleString()}`:""}\n\nType *ORDER [product]* to buy! 🛍️`));
    await incR(); return;
  }

  // ─── UPGRADE ──────────────────────────────────────────────────
  if (/^(upgrade|subscribe|pricing|plan)$/i.test(messageText.trim())) {
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(`🚀 *Upgrade SalesZap*\n\n✅ *Starter* — ₦5,999/mo → 1,000 replies\n✅ *Growth* — ₦14,999/mo → 5,000 replies\n✅ *Pro* — ₦34,999/mo → Unlimited\n\n14-day FREE trial!\n👉 ${process.env.FRONTEND_URL}/pricing.html`));
    await incR(); return;
  }

  // ─── TRACK ────────────────────────────────────────────────────
  if (/^(track|status)\s+\S+/i.test(messageText.trim())) {
    const ref = messageText.trim().split(/\s+/).slice(1).join(" ");
    const { data: ord } = await supabase.from("orders").select("*").eq("business_id", business.id).eq("contact_id", contact?.id).or(`order_number.ilike.%${ref}%,id.ilike.${ref}%`).single();
    if (ord) {
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(`📍 *Order Status*\n\n🆔 ${ord.order_number}\n📦 Status: *${ord.status.toUpperCase()}*\n💳 Payment: ${ord.paystack_status}\n📅 ${new Date(ord.created_at).toLocaleDateString()}${ord.tracking_number?`\n🚚 Tracking: ${ord.tracking_number}`:""}\n\nType *CONTACT* for help! 😊`));
      await incR(); return;
    }
  }

  // ─── ORDER ────────────────────────────────────────────────────
  const trimmedMsg = messageText.trim();
  const wantsOrder = /^(order\s*\(.+\)|order\s+.+|buy\s+.+|purchase\s+.+)$/i.test(trimmedMsg)
    || /\b(i\s+want\s+to\s+buy|i\s+want|i\s+need|i'll\s+take|ill\s+take|give\s+me|get\s+me)\b/i.test(trimmedMsg)
    || /\b(place|placed|confirm|proceed|go ahead|create|make)\b.*\border\b/i.test(trimmedMsg)
    || /^(yes|ok|okay|confirm|proceed|go ahead|place it|create it|make it)$/i.test(trimmedMsg);

  // Track, Reorder, Rate commands already handled above

  if (wantsOrder) {
    try {
      let query = cleanOrderQuery(trimmedMsg);
      let matched = null;
      if (query) {
        const found = await findBestProduct(business.id, query);
        matched = found.product;
      }
      if (!matched) matched = await getPendingProduct(fromPhone, business.id);

      if (matched) {
        const order = await createOrderAndSendPayment({ fromPhone, contact, business, settings, phoneId, token, wrap, product:matched, sourceMessage:messageText });
        if (conversationSession?.id) {
          await updateConversationSession(conversationSession.id, {
            current_intent:"order_created",
            lead_temperature:"hot",
            last_product_discussed: matched.name,
            last_product_id: matched.id,
            last_order_id: order?.id || null,
            handoff_status:"bot_active",
          });
          await logConversationEvent(conversationSession, { direction:"outbound", event_type:"order_created", message_text:`Order created for ${matched.name}`, intent:"order", lead_temperature:"hot", product_id:matched.id, product_name:matched.name, order_id:order?.id || null });
          await learnFromConversation(conversationSession, { learning_type:"successful_order_intent", title:"Customer order phrase", content:messageText, intent:"order", product_name:matched.name, lead_temperature:"hot", is_global_candidate:true });
        }
        if (activeLead?.id && order?.id) {
          await ignoreDb(supabase.from("leads").update({ stage:"ordered", temperature:"hot", last_order_id:order.id, last_product_discussed:matched.name, updated_at:new Date().toISOString() }).eq("id", activeLead.id), "lead order update");
          await ignoreDb(supabase.from("lead_activities").insert({ lead_id:activeLead.id,business_id:business.id,activity_type:"order",title:"Order created",details:`Order ${order.order_number} for ${matched.name}`,new_stage:"ordered",created_by:"bot" }), "lead order activity");
        }
        await incR();
        return;
      }

      const { products } = await findBestProduct(business.id, "");
      let ask = `🛒 I can help you place an order. Please type *ORDER [product name]*.\n\nExample: *ORDER iPhone 16 Pro Max*`;
      if (products?.length) {
        ask += `\n\nAvailable products:\n` + products.slice(0,5).map((p,i)=>`${i+1}. ${p.name}`).join("\n");
      } else {
        ask += `\n\nNo products are listed yet. Type *CONTACT* to speak with the business.`;
      }
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(ask));
      await incR();
      return;
    } catch(orderErr) {
      console.error("❌ Order flow failed:", orderErr.message);
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(`Sorry, I could not create that order right now. Please type *CONTACT* so our team can help you.`));
      await incR();
      return;
    }
  }

  // ─── PRODUCT INTEREST ──────────────────────────────────────────
  if (intent === "product" || intent === "price" || /\b(do you have|available|in stock|tell me about|show me|is there|in stock)\b/i.test(trimmedMsg)) {
    const found = await findBestProduct(business.id, trimmedMsg);
    if (found.product) {
      const p = found.product;
      rememberPendingProduct(fromPhone, business.id, p);
      if (conversationSession?.id) {
        await updateConversationSession(conversationSession.id, {
          current_intent:"viewing_product",
          lead_temperature: mergeLeadTemperature(conversationSession.lead_temperature, "warm"),
          last_product_discussed: p.name,
          last_product_id: p.id,
          handoff_status:"bot_active",
        });
        await logConversationEvent(conversationSession, { direction:"system", event_type:"product_matched", message_text:`Matched product: ${p.name}`, intent:"product", lead_temperature:"warm", product_id:p.id, product_name:p.name, metadata:{ score:found.score } });
        await learnFromConversation(conversationSession, { learning_type:"product_interest", title:"Customer product interest", content:messageText, intent:intent, product_name:p.name, lead_temperature:"warm", is_global_candidate:true, metadata:{ score:found.score } });
      }
      if (activeLead?.id) await ignoreDb(supabase.from("leads").update({ stage:"interested", temperature:"warm", last_product_discussed:p.name, updated_at:new Date().toISOString() }).eq("id", activeLead.id), "lead product update");
      const price = Number(p.sale_price || p.price || 0);
      const oldPrice = p.sale_price && Number(p.price) > Number(p.sale_price) ? ` ~~${p.currency||business.currency||"NGN"} ${Number(p.price).toLocaleString()}~~` : "";
      const deliveryFee = p.type === "digital" ? 0 : Number(business.delivery_fee || 0);
      let productMsg = `✅ *${p.name}* is available.\n\n`;
      productMsg += `💰 Price:${oldPrice} *${p.currency||business.currency||"NGN"} ${price.toLocaleString()}*\n`;
      if (p.description) productMsg += `📝 ${String(p.description).substring(0,180)}\n`;
      productMsg += `${p.type === "digital" ? "⚡ Digital product" : "📦 Physical product"}\n`;
      if (p.type !== "digital") productMsg += `🚚 Delivery: ${business.currency||p.currency||"NGN"} ${deliveryFee.toLocaleString()} • ${business.delivery_days||"1-3 business days"}\n`;
      productMsg += `\nReply *YES* to create the order now, or type *ORDER ${p.name}*.`;
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(productMsg));
      await incR();
      await ignoreDb(supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:productMsg,kb_hit:false,status:"success",confidence:found.score }), "product ai log");
      return;
    }
  }

  // ─── KNOWLEDGE BASE ──────────────────────────────────────────
  const kbMatch = await searchKB(business.id, messageText, lang);
  if (kbMatch) {
    await sleep(1200);
    await sendWA(phoneId, token, fromPhone, wrap(kbMatch.answer));
    await incR();
    await ignoreDb(supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:kbMatch.answer,kb_hit:true,kb_entry_id:kbMatch.id,status:"success",confidence:kbMatch.matchScore }), "kb ai log");
    return;
  }

  // ─── AI (last resort) ──────────────────────────────────────────
  if (settings?.ai_enabled!==false&&planLimits.ai_enabled) {
    try {
      const conversationMemory = await getConversationMemory(conversationSession);
      const aiResult = await callAI(messageText, business, lang, intent, settings, conversationMemory);
      const cleanText = sanitizeAIResponse(aiResult.text);
      if (!cleanText) throw new Error("AI response removed by safety filter");
      await sleep(1500);
      await sendWA(phoneId, token, fromPhone, wrap(cleanText));
      await incR();
      await ignoreDb(supabase.from("ai_logs").insert({ business_id:business.id,contact_phone:fromPhone,incoming_msg:messageText,ai_response:cleanText,kb_hit:false,model_used:"qwen",latency_ms:aiResult.latency,status:"success",confidence:0.85 }), "qwen ai log");
      return;
    } catch(aiErr) {
      console.error("❌ AI failed:", aiErr.message);
      const fallback = `I could not answer that clearly. Please ask one specific question, or type *MENU* to see options.`;
      await sleep(1200);
      await sendWA(phoneId, token, fromPhone, wrap(fallback));
      await incR();
      await ignoreDb(supabase.from("error_reports").insert({ business_id:business.id,error_type:"ai_timeout",context:{message:messageText},message:aiErr.message }), "ai error report");
    }
  }
}

// ============================================================
// WEBHOOKS
// ============================================================

app.get("/webhook/whatsapp", (req, res) => {
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if (mode==="subscribe"&&token===process.env.WA_VERIFY_TOKEN) { console.log("✅ Webhook verified!"); return res.status(200).send(challenge); }
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (!body?.object||body.object!=="whatsapp_business_account") return;
    const entry=body.entry?.[0], changes=entry?.changes?.[0], value=changes?.value, messages=value?.messages;
    if (!messages?.length) return;

    const msg             = messages[0];
    const fromPhone       = msg.from;
    const mediaPayload    = msg.image || msg.document || msg.video || null;
    const mediaType       = msg.image ? "image" : msg.document ? "document" : msg.video ? "video" : null;
    const mediaCaption    = mediaPayload?.caption?.trim() || "";
    const messageText     = (msg.text?.body?.trim() || mediaCaption || (mediaPayload ? "Payment proof received" : ""));
    const waPhoneNumberId = value?.metadata?.phone_number_id;
    const contactName     = value?.contacts?.[0]?.profile?.name||fromPhone;
    const messageId       = msg.id || `${fromPhone}:${messageText}:${msg.timestamp||""}`;
    const incomingMeta    = mediaPayload ? { mediaType, mediaId:mediaPayload.id, mimeType:mediaPayload.mime_type, sha256:mediaPayload.sha256, caption:mediaCaption, messageId } : { messageId };

    if (!messageText||!fromPhone) return;

    // Dedupe
    const now = Date.now();
    for (const [id, ts] of processedMessages.entries()) if (now - ts > MESSAGE_DEDUPE_MS) processedMessages.delete(id);
    if (processedMessages.has(messageId)) { console.log(`↩️ Duplicate WhatsApp message ignored: ${messageId}`); return; }
    processedMessages.set(messageId, now);

    const textKey = `${fromPhone}:${normalizeIncomingText(messageText)}`;
    for (const [key, ts] of inboundTextDedupe.entries()) if (now - ts > TEXT_DEDUPE_MS) inboundTextDedupe.delete(key);
    if (inboundTextDedupe.has(textKey)) { console.log(`↩️ Duplicate WhatsApp text ignored from ${fromPhone}: "${messageText}"`); return; }
    inboundTextDedupe.set(textKey, now);

    console.log(`📨 From ${fromPhone}: "${messageText}"`);

    // Try individual number
    const { data: individualSettings } = await supabase.from("business_settings").select("*, businesses(*)").eq("wa_phone_id", waPhoneNumberId).single();

    if (individualSettings?.businesses) {
      const biz = individualSettings.businesses;
      const tok = individualSettings.wa_access_token||process.env.WA_ACCESS_TOKEN;
      await handleBotMessage(fromPhone, messageText, contactName, biz, individualSettings, waPhoneNumberId, tok, incomingMeta);
      return;
    }

    // Shared number mode
    const platformPhoneId = process.env.WA_PHONE_NUMBER_ID||process.env.WA_PHONE_ID;
    const platformToken   = process.env.WA_ACCESS_TOKEN;

    const existingSession = sharedSessions.get(fromPhone);
    if (existingSession&&new Date(existingSession.expiresAt)>new Date()) {
      if (/^(switch|change|exit|back|main menu|go back)$/i.test(messageText)) {
        sharedSessions.delete(fromPhone);
        await sendWA(platformPhoneId, platformToken, fromPhone, `✅ Disconnected. Type *hi* to browse businesses or type *@username* to connect to one!`);
        return;
      }
      const { data: sharedBiz } = await supabase.from("businesses").select("*").eq("id", existingSession.businessId).single();
      if (sharedBiz && sharedBiz.is_active !== false && sharedBiz.is_suspended !== true) {
        const { data: sharedSettings } = await supabase.from("business_settings").select("*").eq("business_id", sharedBiz.id).single();
        existingSession.expiresAt = new Date(Date.now()+SESSION_MS).toISOString();
        sharedSessions.set(fromPhone, existingSession);
        await handleBotMessage(fromPhone, messageText, contactName, sharedBiz, sharedSettings, platformPhoneId, platformToken, incomingMeta);
        return;
      }
      sharedSessions.delete(fromPhone);
      await sendWA(platformPhoneId, platformToken, fromPhone, `⚠️ This business is currently unavailable. Type *hi* to choose another business.`);
      return;
    }

    // Shortcode
    const shortcodeMatch = messageText.match(/^@([A-Za-z0-9_-]{2,30})$/);
    if (shortcodeMatch) {
      const code = shortcodeMatch[1].toLowerCase();
      const { data: biz } = await supabase.from("businesses").select("*").or(`username.eq.${code},referral_code.ilike.${code}`).eq("is_active", true).single();
      if (biz && biz.is_suspended !== true) {
        sharedSessions.set(fromPhone, { businessId:biz.id, businessName:biz.business_name, expiresAt:new Date(Date.now()+SESSION_MS).toISOString() });
        await sendWA(platformPhoneId, platformToken, fromPhone, `✅ *Welcome to ${biz.business_name}!* 🎉\n\nYou are now connected to their AI assistant.\nType *MENU* for options or *CATALOG* to see their products!\n\n_Type SWITCH to connect to a different business_`);
        return;
      }
    }

    // Directory
    const greetingTest = /^(hi|hello|hey|good morning|good evening|start|help|menu)$/i.test(messageText)||messageText.length<4;
    if (greetingTest) {
      const { data: bizList } = await supabase.from("businesses").select("username,business_name,business_category").eq("is_active", true).not("business_name","is",null).order("referral_count",{ascending:false}).limit(8);
      let dirMsg = `👋 *Welcome to SalesZap!*\n\nConnect with any of our businesses:\n\n`;
      const catEmojis = { fashion:"👗",food:"🍔",tech:"💻",beauty:"✨",health:"💊",services:"🔧",education:"📚",agric:"🌾",other:"🏪" };
      (bizList||[]).forEach(b => { dirMsg += `${catEmojis[b.business_category]||"🏪"} *${b.business_name}*\n   Type: *@${b.username}*\n\n`; });
      dirMsg += `💡 Type *@businessname* to connect!\nExample: *@amarafashion*`;
      await sendWA(platformPhoneId, platformToken, fromPhone, dirMsg);
      return;
    }

    // Try name match
    const { data: nameMatch } = await supabase.from("businesses").select("*").eq("is_active", true).ilike("business_name",`%${messageText}%`).limit(1).single();
    if (nameMatch && nameMatch.is_suspended !== true) {
      sharedSessions.set(fromPhone, { businessId:nameMatch.id, businessName:nameMatch.business_name, expiresAt:new Date(Date.now()+SESSION_MS).toISOString() });
      await sendWA(platformPhoneId, platformToken, fromPhone, `✅ *Welcome to ${nameMatch.business_name}!*\n\nType *MENU* for options!`);
      return;
    }

    await sendWA(platformPhoneId, platformToken, fromPhone, `Type *@businessname* to connect to a business, or type *hi* to see our full directory! 😊`);

  } catch(err) { console.error("💥 Webhook error:", err.message); }
});

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================

async function processSuccessfulOrderPayment(eventData) {
  const meta = eventData.metadata || {};
  const orderId = meta.order_id;
  const bizId = meta.business_id;
  const phone = meta.contact_phone;
  if (!orderId) return null;

  await supabase.from("orders").update({
    paystack_status:"success",
    paystack_ref:eventData.reference,
    paid_at:new Date().toISOString(),
    status:"paid",
    updated_at:new Date().toISOString()
  }).eq("id", orderId);

  await ignoreDb(supabase.from("payments").insert({
    business_id:bizId,
    order_id:orderId,
    type:"order",
    amount:eventData.amount/100,
    currency:eventData.currency,
    paystack_ref:eventData.reference,
    paystack_txn_id:String(eventData.id || eventData.reference),
    status:"success"
  }), "paystack payment log");

  const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
  if (phone && order) {
    const { data: bizSettings } = await supabase.from("business_settings").select("*").eq("business_id", bizId).single();
    const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID || process.env.WA_PHONE_ID;
    let msg = `🎉 *Payment Confirmed!*\n\n✅ Order *${order.order_number}* has been paid.\n💰 ${eventData.currency} ${Number(eventData.amount/100).toLocaleString()}\n\n`;
    if (order.delivery_type === "digital" && !order.digital_sent) {
      msg += `📥 *Your Product:*\n`;
      for (const item of (order.items||[])) {
        const { data: p } = await supabase.from("products").select("digital_link,digital_code").eq("id", item.product_id).single();
        if (p?.digital_link) msg += `🔗 Download: ${p.digital_link}\n`;
        if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
      }
      await supabase.from("orders").update({ digital_sent:true,digital_sent_at:new Date().toISOString(),status:"delivered" }).eq("id", orderId);
    } else {
      msg += `📦 We are preparing your order now. Type *TRACK ${order.order_number}* anytime to check status.`;
    }
    msg += `\n\nThank you! 🙏`;
    if (tok && phoneId) await sendWA(phoneId, tok, phone, msg);

    const { data: c } = await supabase.from("contacts").select("*").eq("business_id", bizId).eq("phone", phone).single();
    if (c) await ignoreDb(supabase.from("contacts").update({ total_orders:(c.total_orders||0)+1,total_spent:Number(c.total_spent||0)+Number(order.total||0) }).eq("id", c.id), "contact spend update");
  }

  notifySubscriber(bizId, `💰 *Payment Received!*\n\nOrder ${order?.order_number || orderId.substring(0,8).toUpperCase()} paid via Paystack.\nAmount: ${eventData.currency} ${eventData.amount/100}`).catch(()=>{});
  return order;
}

app.get("/webhook/paystack/verify", async (req, res) => {
  try {
    const reference = req.query.reference || req.query.trxref;
    if (!reference) return res.status(400).send("Missing payment reference.");
    const { data: order } = await supabase.from("orders").select("id,business_id,paystack_ref").eq("paystack_ref", reference).single();
    if (!order) return res.status(404).send("Order not found.");
    const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret").eq("business_id", order.business_id).single();
    const secret = bizSettings?.paystack_secret || process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(400).send("Payment verification is not configured.");
    const verify = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers:{ Authorization:`Bearer ${secret}` } });
    const data = verify.data?.data;
    if (data?.status === "success") {
      await processSuccessfulOrderPayment(data);
      return res.send(`<html><body style="font-family:Arial;text-align:center;padding:40px;"><h2>✅ Payment confirmed</h2><p>Your order has been paid successfully. You can return to WhatsApp.</p></body></html>`);
    }
    return res.send(`<html><body style="font-family:Arial;text-align:center;padding:40px;"><h2>Payment not completed</h2><p>Status: ${data?.status || "unknown"}</p></body></html>`);
  } catch(err) {
    console.error("Paystack verify error:", err.response?.data || err.message);
    res.status(500).send("Payment verification failed. Please contact support.");
  }
});

app.post("/webhook/paystack", async (req, res) => {
  try {
    const sig = req.headers["x-paystack-signature"];
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const event = JSON.parse(raw.toString());
    const meta = event?.data?.metadata || {};
    const bizId = meta.business_id;

    let secrets = [process.env.PAYSTACK_SECRET_KEY].filter(Boolean);
    if (bizId) {
      const { data: bizSettings } = await supabase.from("business_settings").select("paystack_secret").eq("business_id", bizId).single();
      if (bizSettings?.paystack_secret) secrets.unshift(bizSettings.paystack_secret);
    }
    const valid = secrets.some(secret => crypto.createHmac("sha512", secret).update(raw).digest("hex") === sig);
    if (!valid) return res.sendStatus(401);

    console.log(`💳 Paystack: ${event.event}`);
    if (event.event === "charge.success") await processSuccessfulOrderPayment(event.data);
    res.sendStatus(200);
  } catch(err) { console.error("💥 Paystack error:", err.message); res.sendStatus(500); }
});

// ============================================================
// CRM / PIPELINE
// ============================================================

app.get("/crm/pipeline-stats", requireAuth, async (req, res) => {
  try {
    const { data: leads } = await supabase.from("leads").select("stage,temperature,status,next_followup_at").eq("business_id", req.business.id);
    const stats = { total:0, hot:0, warm:0, cold:0, not_interested:0, due_followups:0, by_stage:{} };
    const now = Date.now();
    (leads||[]).forEach(l => {
      stats.total++;
      if (stats[l.temperature] !== undefined) stats[l.temperature]++;
      stats.by_stage[l.stage] = (stats.by_stage[l.stage]||0)+1;
      if (l.status === "active" && l.next_followup_at && new Date(l.next_followup_at).getTime() <= now) stats.due_followups++;
    });
    res.json({ success:true, stats });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/crm/leads", requireAuth, async (req, res) => {
  try {
    const { stage, temperature, status, search } = req.query;
    let q = supabase.from("leads").select("*").eq("business_id", req.business.id).order("updated_at",{ascending:false}).limit(200);
    if (stage) q = q.eq("stage", stage);
    if (temperature) q = q.eq("temperature", temperature);
    if (status) q = q.eq("status", status);
    if (search) {
      const term = String(search).replace(/[%(),]/g, "").trim();
      if (term) q = q.or(`name.ilike.%${term}%,contact_phone.ilike.%${term}%,last_message.ilike.%${term}%,last_product_discussed.ilike.%${term}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, leads:data||[], total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/crm/leads/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["stage","temperature","status","assigned_to","next_followup_at","followup_stop_reason","notes"];
    const updates = { updated_at:new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data: oldLead } = await supabase.from("leads").select("stage").eq("business_id", req.business.id).eq("id", req.params.id).single();
    const { data, error } = await supabase.from("leads").update(updates).eq("business_id", req.business.id).eq("id", req.params.id).select().single();
    if (error) throw error;
    if (oldLead?.stage && updates.stage && oldLead.stage !== updates.stage) {
      await ignoreDb(supabase.from("lead_activities").insert({ lead_id:req.params.id,business_id:req.business.id,activity_type:"stage_change",title:"Stage changed",old_stage:oldLead.stage,new_stage:updates.stage,created_by:req.business.username }), "manual lead stage activity");
    }
    res.json({ success:true, lead:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/crm/leads/:id/activities", requireAuth, async (req, res) => {
  try {
    const { title, details, activityType } = req.body;
    const { data, error } = await supabase.from("lead_activities").insert({ lead_id:req.params.id,business_id:req.business.id,activity_type:activityType||"note",title:title||"Note",details:details||"",created_by:req.business.username }).select().single();
    if (error) throw error;
    res.json({ success:true, activity:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/crm/followups", requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let q = supabase.from("lead_followups").select("*, leads(name,contact_phone,stage,temperature,last_product_discussed)").eq("business_id", req.business.id).order("due_at",{ascending:true}).limit(100);
    if (status) q = q.eq("status", status); else q = q.eq("status", "pending");
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, followups:data||[] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/crm/followups/:id/complete", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("lead_followups").update({ status:"done", completed_at:new Date().toISOString() }).eq("business_id", req.business.id).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success:true, followup:data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ADMIN PANEL
// ============================================================

app.get("/admin/me", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    res.json({ success:true, username:req.business.username, role:admin.role, permissions:admin.permissions });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/all-businesses", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_subscribers");
    if (!admin) return;
    const { search, plan, status, city, limit } = req.query;
    let q = supabase.from("businesses")
      .select("id,username,email,phone,contact_phone,business_name,business_category,city,state,country,plan,reply_count,reply_limit,created_at,last_login_at,updated_at,is_active,is_suspended,suspension_reason,email_verified,template_applied")
      .order("created_at",{ascending:false})
      .limit(Math.min(Number(limit)||100, 500));

    if (plan && ["free","starter","growth","pro"].includes(String(plan))) q = q.eq("plan", plan);
    if (city) q = q.ilike("city", `%${city}%`);
    if (status === "active") q = q.eq("is_active", true).or("is_suspended.is.null,is_suspended.eq.false");
    if (status === "disabled") q = q.or("is_active.eq.false,is_suspended.eq.true");
    if (status === "unverified") q = q.eq("email_verified", false);
    if (search) {
      const term = String(search).replace(/[%(),]/g, "").trim();
      if (term) q = q.or(`username.ilike.%${term}%,business_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,contact_phone.ilike.%${term}%,city.ilike.%${term}%,state.ilike.%${term}%`);
    }

    const { data, error } = await q;
    if (error) throw error;
    const ids = (data||[]).map(b=>b.id);
    let counts = {};
    if (ids.length) {
      const { data: orders } = await supabase.from("orders").select("business_id").in("business_id", ids);
      (orders||[]).forEach(o=>{ counts[o.business_id]=(counts[o.business_id]||0)+1; });
    }
    await logAdminAction(req, "tenant_list_view", "business", null, { search:search||null, plan:plan||null, status:status||null, total:data?.length||0 });
    res.json({
      success:true,
      admin,
      businesses:(data||[]).map(b=>({...b,total_orders:counts[b.id]||0, location:[b.city,b.state,b.country].filter(Boolean).join(", ")})),
      total:data?.length||0
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/platform-stats", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    const { count: bizCount }   = await supabase.from("businesses").select("id",{count:"exact",head:true});
    const { count: activeBizCount } = await supabase.from("businesses").select("id",{count:"exact",head:true}).eq("is_active", true);
    const { count: orderCount } = await supabase.from("orders").select("id",{count:"exact",head:true});
    const { count: contactCount } = await supabase.from("contacts").select("id",{count:"exact",head:true});
    const { data: revData }     = await supabase.from("orders").select("total").eq("paystack_status","success");
    const totalRevenue = (revData||[]).reduce((s,o)=>s+Number(o.total||0), 0);
    res.json({ success:true, stats:{ total_businesses:bizCount||0, active_businesses:activeBizCount||0, total_orders:orderCount||0, total_contacts:contactCount||0, total_revenue:totalRevenue } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/set-plan", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "set_plan");
    if (!admin) return;
    const { plan, businessId } = req.body;
    if (!PLAN_LIMITS[plan]) return res.status(400).json({ error:"Invalid plan." });
    const targetId = businessId||req.business.id;
    await supabase.from("businesses").update({ plan, reply_limit:PLAN_LIMITS[plan].reply_limit, updated_at:new Date().toISOString() }).eq("id", targetId);
    await logAdminAction(req, "tenant_plan_changed", "business", targetId, { plan });
    res.json({ success:true, message:`✅ Plan set to ${plan}`, plan });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch("/admin/businesses/:id/status", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_subscribers");
    if (!admin) return;
    const { active, suspended, reason } = req.body;
    const updates = { updated_at:new Date().toISOString() };
    if (typeof active === "boolean") updates.is_active = active;
    if (typeof suspended === "boolean") updates.is_suspended = suspended;
    if (reason !== undefined) updates.suspension_reason = reason || null;
    const { data, error } = await supabase.from("businesses").update(updates).eq("id", req.params.id).select("id,username,business_name,is_active,is_suspended,suspension_reason").single();
    if (error) throw error;
    if (active === false || suspended === true) {
      await ignoreDb(supabase.from("sessions").update({ is_active:false }).eq("business_id", req.params.id), "disable sessions");
    }
    await logAdminAction(req, "tenant_status_changed", "business", req.params.id, { active, suspended, reason });
    res.json({ success:true, business:data, message:`✅ Subscriber ${data.username} updated.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/suspend-business", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_subscribers");
    if (!admin) return;
    const { businessId, reason, suspend } = req.body;
    const suspended = suspend !== false;
    await supabase.from("businesses").update({ is_active:!suspended, is_suspended:suspended, suspension_reason:suspended ? (reason||"Suspended by admin") : null, updated_at:new Date().toISOString() }).eq("id", businessId);
    if (suspended) await ignoreDb(supabase.from("sessions").update({ is_active:false }).eq("business_id", businessId), "suspend sessions");
    res.json({ success:true, message:`Business ${suspended?"disabled":"reactivated"}.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/admin/businesses/:id", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "delete_subscribers");
    if (!admin) return;
    const businessId = req.params.id;
    if (businessId === req.business.id) return res.status(400).json({ error:"You cannot delete your own admin account." });

    const { data: target } = await supabase.from("businesses").select("id,username,business_name").eq("id", businessId).single();
    if (!target) return res.status(404).json({ error:"Subscriber not found." });

    const tables = [
      "sessions",
      "ai_logs",
      "error_reports",
      "broadcasts",
      "orders",
      "contacts",
      "products",
      "knowledge_base",
      "business_settings",
      "usage_logs",
      "payment_transactions"
    ];
    for (const table of tables) {
      await ignoreDb(supabase.from(table).delete().eq("business_id", businessId), `delete ${table}`);
    }
    await ignoreDb(supabase.from("referrals").delete().or(`referrer_id.eq.${businessId},referred_id.eq.${businessId}`), "delete referrals");
    const { error } = await supabase.from("businesses").delete().eq("id", businessId);
    if (error) throw error;
    await logAdminAction(req, "tenant_deleted", "business", businessId, { username:target.username, business_name:target.business_name });
    res.json({ success:true, message:`🗑️ Deleted subscriber @${target.username}.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/staff", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_staff");
    if (!admin) return;
    const envStaff = getAdmins().map(username => ({
      username,
      role: listEnv("ADMIN_OWNER_USERNAMES").includes(username) || listEnv("ADMIN_USERNAMES").includes(username) ? "owner" : listEnv("ADMIN_LIMITED_USERNAMES").includes(username) ? "support" : "manager",
      is_active:true,
      source:"Render env"
    }));
    let dbStaff = [];
    let setupNeeded = false;
    try {
      const { data, error } = await supabase.from("admin_staff").select("id,username,role,is_active,notes,created_at,updated_at").order("created_at",{ascending:false});
      if (error) throw error;
      dbStaff = (data||[]).map(s=>({...s,source:"Database"}));
    } catch(e) { setupNeeded = true; }
    res.json({ success:true, staff:[...envStaff, ...dbStaff], setupNeeded, permissions:ADMIN_PERMISSIONS });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/staff", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_staff");
    if (!admin) return;
    const username = String(req.body.username||"").trim().toLowerCase();
    const role = String(req.body.role||"viewer").trim().toLowerCase();
    const notes = req.body.notes || null;
    if (!username || !/^[a-z0-9_-]{2,30}$/.test(username)) return res.status(400).json({ error:"Valid username required." });
    if (!ADMIN_PERMISSIONS[role] || role === "owner") return res.status(400).json({ error:"Role must be manager, support, or viewer. Owner stays in Render env for safety." });
    const { data: biz } = await supabase.from("businesses").select("id,username").eq("username", username).single();
    if (!biz) return res.status(404).json({ error:"That username is not a SalesZap account yet. Ask the staff member to sign up first." });
    const payload = { username, role, is_active:true, notes, invited_by:req.business.username, updated_at:new Date().toISOString() };
    const { data, error } = await supabase.from("admin_staff").upsert(payload, { onConflict:"username" }).select().single();
    if (error) throw error;
    await logAdminAction(req, "staff_role_upserted", "admin_staff", username, { role, notes });
    res.json({ success:true, staff:data, message:`✅ @${username} is now ${role} staff.` });
  } catch(err) {
    const msg = String(err.message||"");
    if (msg.includes("admin_staff")) return res.status(500).json({ error:"Admin staff table is missing. Run admin_staff_roles.sql in Supabase first." });
    res.status(500).json({ error: err.message });
  }
});

app.patch("/admin/staff/:username", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_staff");
    if (!admin) return;
    const username = String(req.params.username||"").trim().toLowerCase();
    if (getAdmins().includes(username)) return res.status(400).json({ error:"Render-env admins must be changed in Render, not the dashboard." });
    const updates = { updated_at:new Date().toISOString() };
    if (req.body.role) {
      const role = String(req.body.role).toLowerCase();
      if (!ADMIN_PERMISSIONS[role] || role === "owner") return res.status(400).json({ error:"Invalid role." });
      updates.role = role;
    }
    if (typeof req.body.isActive === "boolean") updates.is_active = req.body.isActive;
    if (req.body.notes !== undefined) updates.notes = req.body.notes || null;
    const { data, error } = await supabase.from("admin_staff").update(updates).eq("username", username).select().single();
    if (error) throw error;
    res.json({ success:true, staff:data, message:`✅ Staff @${username} updated.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/admin/staff/:username", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "manage_staff");
    if (!admin) return;
    const username = String(req.params.username||"").trim().toLowerCase();
    if (getAdmins().includes(username)) return res.status(400).json({ error:"Render-env admins must be removed in Render, not the dashboard." });
    const { error } = await supabase.from("admin_staff").delete().eq("username", username);
    if (error) throw error;
    await logAdminAction(req, "staff_role_removed", "admin_staff", username, {});
    res.json({ success:true, message:`🗑️ Removed @${username} from staff.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/test-message", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "test_message");
    if (!admin) return;
    const { phone, message } = req.body;
    if (!phone||!message) return res.status(400).json({ error:"Phone and message required." });
    const phoneId = process.env.WA_PHONE_NUMBER_ID||process.env.WA_PHONE_ID;
    const token   = process.env.WA_ACCESS_TOKEN;
    if (!phoneId||!token) return res.status(400).json({ error:"WhatsApp not configured." });
    const result = await sendWA(phoneId, token, phone, message);
    res.json(result.success ? { success:true, messageId:result.messageId } : { success:false, error:result.error });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/audit-logs", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    const { action, adminUsername, targetId, limit } = req.query;
    let q = supabase.from("admin_audit_logs").select("*").order("created_at",{ascending:false}).limit(Math.min(Number(limit)||100, 300));
    if (action) q = q.eq("action", action);
    if (adminUsername) q = q.eq("admin_username", String(adminUsername).toLowerCase());
    if (targetId) q = q.eq("target_id", targetId);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success:true, logs:data||[] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/global-kb", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    const { data, error } = await supabase.from("global_kb_library").select("*").order("uses",{ascending:false});
    if (error) throw error;
    res.json({ success:true, keywords:data, total:data?.length||0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ADMIN OTP DIAGNOSTICS
// ============================================================

app.get("/admin/otp-health", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    const config = brevoConfigStatus();
    const brevo = await verifyBrevoAccount();
    let recent = [];
    try {
      const { data } = await supabase.from("otp_delivery_logs").select("masked_identifier,type,channel,provider,status,error_message,created_at").order("created_at",{ascending:false}).limit(20);
      recent = data || [];
    } catch(e) {}
    res.json({ success:true, config, brevo, recent });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/test-otp-email", requireAuth, async (req, res) => {
  try {
    const admin = await requireAdminPermission(req, res, "view_stats");
    if (!admin) return;
    const email = (req.body.email || req.business.email || "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error:"Valid email required." });
    const otp = genOTP();
    await saveOTPRecord(email, "email_verify", otp);
    const sent = await sendOTPEmail(email, otp, "email_verify");
    res.json({ success:sent, delivery:sent ? "email" : "failed", message:sent ? `✅ Test OTP sent to ${maskEmail(email)}` : "❌ Test OTP failed. Check /admin/otp-health and Render logs." });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SCHEDULED TASK WORKER
// ============================================================

async function processScheduledTasks() {
  try {
    const now = new Date().toISOString();

    const { data: tasks } = await supabase
      .from("scheduled_tasks")
      .select("*, orders(contact_id, contacts(phone, name), order_number)")
      .eq("status", "pending")
      .lte("scheduled_at", now)
      .limit(100);

    for (const task of tasks || []) {
      try {
        if (task.task_type === "delivery_confirmation") {
          const order = task.orders;
          if (order?.contacts?.phone) {
            const { data: bizSettings } = await supabase
              .from("business_settings")
              .select("*")
              .eq("business_id", task.business_id)
              .single();
            const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
            const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID;

            if (tok && phoneId) {
              let msg = `📦 *Delivery Check-in*\n\n`;
              msg += `Did you receive your order *${order.order_number}*? ✅\n\n`;
              msg += `Reply *YES* if received, or *NO* if not yet delivered.\n`;
              msg += `If you need help, type *CONTACT* to reach the business.`;
              await sendWA(phoneId, tok, order.contacts.phone, msg);
            }
          }
          await supabase.from("scheduled_tasks").update({
            status: "completed",
            completed_at: new Date().toISOString()
          }).eq("id", task.id);
        }

        if (task.task_type === "followup") {
          const { data: lead } = await supabase
            .from("leads")
            .select("*")
            .eq("contact_id", task.contact_id)
            .single();

          if (lead && lead.status === "active") {
            const { data: bizSettings } = await supabase
              .from("business_settings")
              .select("*")
              .eq("business_id", task.business_id)
              .single();
            const tok = bizSettings?.wa_access_token || process.env.WA_ACCESS_TOKEN;
            const phoneId = bizSettings?.wa_phone_id || process.env.WA_PHONE_NUMBER_ID;

            if (tok && phoneId && lead.contact_phone) {
              let msg = `👋 *Hello ${lead.name || "there"}!*\n\n`;
              msg += `It's been a while since we last chatted.\n`;
              msg += `Are you still interested in what we talked about?\n\n`;
              msg += `Reply *YES* to continue, or *NO* to stop these messages.`;
              await sendWA(phoneId, tok, lead.contact_phone, msg);
            }
          }
          await supabase.from("scheduled_tasks").update({
            status: "completed",
            completed_at: new Date().toISOString()
          }).eq("id", task.id);
        }
      } catch (taskErr) {
        console.error(`Task ${task.id} failed:`, taskErr.message);
        await supabase.from("scheduled_tasks").update({
          status: "failed",
          error: taskErr.message
        }).eq("id", task.id);
      }
    }
  } catch (err) {
    console.error("Scheduler error:", err.message);
  }
}

setInterval(processScheduledTasks, 5 * 60 * 1000);
setTimeout(processScheduledTasks, 10000);

// ============================================================
// SEED SAMPLE DATA
// ============================================================

async function seedSampleDataForBusiness(bizId) {
  const sampleProducts = [
    { name: "Red Wig", price: 45000, sale_price: 42000, category: "hair", type: "physical", stock: 18 },
    { name: "iPhone 16 Pro Max", price: 1850000, category: "electronics", type: "physical", stock: 7 },
    { name: "Premium Hair Oil 100ml", price: 8500, category: "beauty", type: "physical", stock: 42 },
    { name: "Jollof Rice Spice Pack", price: 3200, category: "food", type: "physical", stock: 120 },
    { name: "Digital E-book: WhatsApp Sales Mastery", price: 7500, category: "digital", type: "digital", digital_link: "https://example.com/ebook.pdf" }
  ];

  for (const p of sampleProducts) {
    await supabase.from("products").insert({
      business_id: bizId,
      name: p.name,
      price: p.price,
      sale_price: p.sale_price || null,
      category: p.category,
      type: p.type,
      stock: p.stock || null,
      digital_link: p.digital_link || null,
      is_active: true
    });
  }

  const sampleContacts = [
    { name: "Adaobi Okoro", phone: "+2348031234567" },
    { name: "Chinedu Eze", phone: "+2348023456789" },
    { name: "Fatima Bello", phone: "+2348098765432" }
  ];

  for (const c of sampleContacts) {
    await supabase.from("contacts").insert({
      business_id: bizId,
      name: c.name,
      phone: c.phone,
      opted_in: true
    });
  }
  console.log("✅ Auto-seeded sample data for business", bizId);
}

app.post("/dashboard/seed-sample-data", requireAuth, async (req, res) => {
  try {
    const bizId = req.business.id;
    await seedSampleDataForBusiness(bizId);
    res.json({ success: true, message: "✅ Sample products + contacts seeded. Refresh dashboard." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HEALTH & ROOT
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status:    `✅ SalesZap v3.2.0 is running`,
    version:   "3.2.0",
    app:       APP_NAME,
    tagline:   TAGLINE,
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    env:       process.env.NODE_ENV||"production",
    features:  ["multi-tenant","auth","otp-email","otp-whatsapp","shared-number","individual-number","product-edit","admin-panel","payment-flex","bank-opay-palmpay","global-kb","100-templates","ai-self-healing","message-queue","paystack","full-lifecycle","scheduler"],
    queue:     msgQueue.stats,
  });
});

app.get("/", (req, res) => {
  res.json({ 
    app: APP_NAME, 
    version: "3.2.0", 
    status: "🟢 Live", 
    tagline: TAGLINE,
    website: process.env.FRONTEND_URL || "https://zapitapps.github.io/saleszap"
  });
});
// ─── BSP WEBHOOK CALLBACK ──────────────────────────────────────
app.post("/webhook/bsp/callback", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    console.log('📞 BSP Callback received:', body);

    // Different BSPs send different payloads
    const sessionToken = body.sessionToken || body.session || body.session_id;
    const phoneNumberId = body.phoneNumberId || body.wa_phone_id || body.phone_number_id;
    const accessToken = body.accessToken || body.wa_access_token || body.access_token;
    const businessId = body.businessId || body.business_id;

    // If we have a session token, look up the business
    if (sessionToken) {
      const { data: connection } = await supabase
        .from('whatsapp_connections')
        .select('business_id, phone_number')
        .eq('session_token', sessionToken)
        .eq('status', 'pending')
        .single();

      if (connection) {
        // Save the credentials to business_settings
        await supabase.from('business_settings')
          .update({
            wa_phone_id: phoneNumberId,
            wa_access_token: accessToken,
            wa_business_id: body.businessId || body.wa_business_id || null,
            updated_at: new Date().toISOString()
          })
          .eq('business_id', connection.business_id);

        // Mark the connection as completed
        await supabase.from('whatsapp_connections')
          .update({
            status: 'completed',
            wa_phone_id: phoneNumberId,
            completed_at: new Date().toISOString()
          })
          .eq('session_token', sessionToken);

        // Notify the business owner
        await notifySubscriber(connection.business_id,
          `✅ *WhatsApp Connected!*\n\nYour number ${connection.phone_number} is now connected to SalesZap.\n\nYou can now receive customer messages directly on your number! 🎉`
        );

        return res.send(`
          <html><body style="font-family:Arial;text-align:center;padding:40px;background:#0B0F1A;color:#F8FAFC;">
            <div style="max-width:400px;margin:0 auto;background:#111827;padding:40px;border-radius:16px;">
              <h1 style="color:#25D366;">✅ WhatsApp Connected!</h1>
              <p>Your number is now connected to SalesZap.</p>
              <p style="color:#94A3B8;font-size:0.9rem;">You can close this window and return to your dashboard.</p>
              <a href="${process.env.FRONTEND_URL}/dashboard.html" style="display:inline-block;margin-top:20px;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;padding:12px 30px;border-radius:30px;text-decoration:none;font-weight:700;">Go to Dashboard →</a>
            </div>
          </body></html>
        `);
      }
    }

    // If we have a business ID directly (some BSPs send it)
    if (businessId && phoneNumberId && accessToken) {
      await supabase.from('business_settings')
        .update({
          wa_phone_id: phoneNumberId,
          wa_access_token: accessToken,
          wa_business_id: body.wa_business_id || null,
          updated_at: new Date().toISOString()
        })
        .eq('business_id', businessId);

      // Also update the businesses table
      await supabase.from('businesses')
        .update({
          whatsapp_number: body.phoneNumber || body.phone_number || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', businessId);

      return res.status(200).json({ success: true, message: 'WhatsApp connected successfully!' });
    }

    res.status(400).json({ error: 'Missing required data in callback.' });

  } catch (error) {
    console.error('BSP callback error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
app.use((req,res) => res.status(404).json({ error:"Route not found", path:req.path }));
app.use((err,req,res,next) => { console.error("💥", err.message); res.status(500).json({ error:"Internal server error" }); });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n⚡ SalesZap v3.2.0 running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`💬 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🏷️  ${TAGLINE}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV||"production"}\n`);
});

module.exports = app;
