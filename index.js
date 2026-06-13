// ============================================================
// VendrAI Backend v2.0 — Multi-Tenant SaaS
// Auth + Onboarding + Excel Import + Per-Subscriber Dashboards
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
  process.env.SUPABASE_URL          || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY  || "placeholder"
);

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(morgan("combined"));
app.use("/webhook/paystack", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));   // 50mb for Excel data
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// ── Strict limiter for auth routes ──
const authLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many attempts. Wait 1 minute." } });

// ============================================================
// PLAN LIMITS
// ============================================================
const PLAN_LIMITS = {
  free:    { reply_limit: 100,    product_limit: 5,    contact_limit: 100,   broadcast_limit: 0,    kb_limit: 20,   ai_enabled: true,  broadcasts_enabled: false, analytics: false, excel_import: false, remove_watermark: false },
  starter: { reply_limit: 500,    product_limit: 20,   contact_limit: 500,   broadcast_limit: 100,  kb_limit: 100,  ai_enabled: true,  broadcasts_enabled: true,  analytics: false, excel_import: false, remove_watermark: true  },
  growth:  { reply_limit: 3000,   product_limit: 100,  contact_limit: 5000,  broadcast_limit: 500,  kb_limit: 500,  ai_enabled: true,  broadcasts_enabled: true,  analytics: true,  excel_import: true,  remove_watermark: true  },
  pro:     { reply_limit: 999999, product_limit: 9999, contact_limit: 99999, broadcast_limit: 9999, kb_limit: 9999, ai_enabled: true,  broadcasts_enabled: true,  analytics: true,  excel_import: true,  remove_watermark: true  },
};

const WATERMARK = "\n\n_Powered by VendrAI_ 🤖 | vendrai.app";
const HF_MODEL  = "Qwen/Qwen2.5-72B-Instruct";
const HF_API    = "https://api-inference.huggingface.co/models/";

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + process.env.ADMIN_SECRET_TOKEN).digest("hex");
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function generateReferralCode() {
  return "VND-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function detectLanguage(text) {
  const lower = text.toLowerCase();
  if (/\b(abeg|wahala|oga|wetin|dey|na im|sabi)\b/i.test(lower)) return "pidgin";
  if (/\b(ẹ|ọ|ṣe|bawo|elo ni|ese)\b/i.test(lower)) return "yo";
  if (/\b(ndewo|nnọọ|biko|igbo)\b/i.test(lower)) return "ig";
  if (/\b(sannu|nawa ne|don allah|aboki)\b/i.test(lower)) return "ha";
  return "en";
}

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(hi|hello|hey|good morning|good evening|howdy)\b/i.test(lower)) return "greeting";
  if (/\b(order|buy|purchase|i want|i need|place order)\b/i.test(lower)) return "order";
  if (/\b(price|how much|cost|fee|rate|naira)\b/i.test(lower)) return "price";
  if (/\b(track|status|where is|my order)\b/i.test(lower)) return "track";
  if (/\b(pay|payment|bank|transfer|card|mobile money)\b/i.test(lower)) return "payment";
  if (/\b(deliver|ship|shipping|how long)\b/i.test(lower)) return "delivery";
  if (/\b(contact|phone|email|call|human|agent|support)\b/i.test(lower)) return "contact";
  if (/\b(catalog|product|shop|browse|list|stock)\b/i.test(lower)) return "product";
  if (/\b(cancel|return|refund)\b/i.test(lower)) return "cancel";
  if (/\b(help|menu|options|start|commands)\b/i.test(lower)) return "help";
  return "general";
}

function fuzzyMatch(text, keyword) {
  const t = text.toLowerCase().split(/\s+/);
  const k = keyword.toLowerCase().split(/\s+/);
  const m = k.filter(kw => t.some(tw => tw.includes(kw) || kw.includes(tw)));
  return m.length / k.length;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// AUTH MIDDLEWARE — Session Token
// ============================================================

async function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Not logged in. Please log in first." });

  const { data: session } = await supabase
    .from("sessions")
    .select("*, businesses(*)")
    .eq("session_token", token)
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!session) return res.status(401).json({ error: "Session expired. Please log in again." });

  // Update last used
  await supabase.from("sessions").update({ last_used_at: new Date().toISOString() }).eq("id", session.id);

  req.business = session.businesses;
  req.session  = session;
  next();
}

// Plan feature check middleware
function requirePlan(feature) {
  return (req, res, next) => {
    const plan   = req.business?.plan || "free";
    const limits = PLAN_LIMITS[plan];
    if (!limits[feature]) {
      return res.status(403).json({
        error: `This feature requires a higher plan.`,
        feature,
        current_plan: plan,
        upgrade_url: `${process.env.FRONTEND_URL}/pricing.html`,
        message: `Upgrade to unlock ${feature}. Visit ${process.env.FRONTEND_URL}/pricing.html`
      });
    }
    next();
  };
}

// ============================================================
// EMAIL / OTP SENDER (via simple HTTP — no extra package)
// ============================================================

async function sendOTPEmail(email, otp, type = "verify") {
  // Using EmailJS free API or similar — placeholder for now
  // In production: integrate with Brevo (free 300 emails/day) or Mailgun
  console.log(`📧 OTP for ${email}: ${otp} (type: ${type})`);
  // TODO: Replace with actual email service
  return true;
}

async function sendOTPSMS(phone, otp) {
  // Using Termii or Africa's Talking free tier
  console.log(`📱 SMS OTP for ${phone}: ${otp}`);
  // TODO: Replace with actual SMS service
  return true;
}

// ============================================================
// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════
// ============================================================

// POST /auth/register — New subscriber signup
app.post("/auth/register", authLimiter, async (req, res) => {
  try {
    const { username, email, phone, password, businessName, referralCode } = req.body;

    // Validate required fields
    if (!username || !email || !phone || !password || !businessName) {
      return res.status(400).json({ error: "All fields are required: username, email, phone, password, businessName" });
    }

    // Validate username format (letters, numbers, underscores only)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3-30 characters: letters, numbers, underscores only. No spaces." });
    }

    // Validate email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    // Validate phone (must start with + and country code)
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ error: "Phone must include country code. Example: +2348012345678" });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    // Check username taken
    const { data: existingUser } = await supabase.from("businesses").select("id").eq("username", username.toLowerCase()).single();
    if (existingUser) return res.status(409).json({ error: "This username is already taken. Please choose another." });

    // Check email taken
    const { data: existingEmail } = await supabase.from("businesses").select("id").eq("email", email.toLowerCase()).single();
    if (existingEmail) return res.status(409).json({ error: "This email is already registered. Try logging in instead." });

    // Check phone taken
    const { data: existingPhone } = await supabase.from("businesses").select("id").eq("phone", phone).single();
    if (existingPhone) return res.status(409).json({ error: "This phone number is already registered." });

    // Find referrer
    let referrerId = null;
    if (referralCode) {
      const { data: referrer } = await supabase.from("businesses").select("id").eq("referral_code", referralCode).single();
      if (referrer) referrerId = referrer.id;
    }

    // Create business
    const { data: biz, error: bizErr } = await supabase.from("businesses").insert({
      username:       username.toLowerCase(),
      email:          email.toLowerCase(),
      phone,
      password_hash:  hashPassword(password),
      business_name:  businessName,
      whatsapp_number: phone,  // default WA = signup phone (can change later)
      referral_code:  generateReferralCode(),
      referred_by:    referrerId,
      plan:           "free",
      reply_limit:    100,
    }).select().single();

    if (bizErr) throw bizErr;

    // Create default settings
    await supabase.from("business_settings").insert({
      business_id:    biz.id,
      wa_verify_token: generateToken().substring(0, 20),
    });

    // Create subscription (14-day trial)
    await supabase.from("subscriptions").insert({
      business_id: biz.id,
      plan:        "free",
      status:      "trial",
    });

    // Clone default KB templates
    const { data: templates } = await supabase.from("default_kb_templates").select("*");
    if (templates?.length) {
      await supabase.from("knowledge_base").insert(
        templates.map(t => ({ business_id: biz.id, keyword: t.keyword, answer: t.answer, category: t.category, language: t.language }))
      );
    }

    // Track referral
    if (referrerId) {
      await supabase.from("referrals").insert({ referrer_id: referrerId, referred_id: biz.id, referral_code: referralCode, status: "signed_up" });
      const { data: ref } = await supabase.from("businesses").select("referral_count").eq("id", referrerId).single();
      await supabase.from("businesses").update({ referral_count: (ref?.referral_count || 0) + 1 }).eq("id", referrerId);
    }

    // Generate email OTP
    const otp = generateOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "email_verify", otp_code: otp });
    await sendOTPEmail(email, otp, "verify");

    // Create session (login immediately)
    const sessionToken = generateToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });

    res.status(201).json({
      success: true,
      message: "✅ Account created! Check your email for verification code.",
      session_token: sessionToken,
      business: {
        id:           biz.id,
        username:     biz.username,
        businessName: biz.business_name,
        email:        biz.email,
        phone:        biz.phone,
        plan:         biz.plan,
        referralCode: biz.referral_code,
        emailVerified: false,
        onboardingComplete: false,
      },
      next_step: "verify_email",
    });

  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// POST /auth/login — Login with username/email + password
app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = username OR email
    if (!identifier || !password) return res.status(400).json({ error: "Username/email and password are required." });

    // Find business by username or email
    const { data: biz } = await supabase.from("businesses")
      .select("*")
      .or(`username.eq.${identifier.toLowerCase()},email.eq.${identifier.toLowerCase()}`)
      .single();

    if (!biz) return res.status(401).json({ error: "No account found with that username or email." });

    // Check password
    if (biz.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: "Incorrect password. Please try again." });
    }

    // Check if suspended
    if (biz.is_suspended) {
      return res.status(403).json({ error: `Account suspended: ${biz.suspension_reason || "Contact support."}` });
    }

    // Create new session
    const sessionToken = generateToken();
    await supabase.from("sessions").insert({ business_id: biz.id, session_token: sessionToken });

    // Update last login
    await supabase.from("businesses").update({ last_login_at: new Date().toISOString() }).eq("id", biz.id);

    // Get plan limits
    const limits = PLAN_LIMITS[biz.plan] || PLAN_LIMITS.free;

    res.json({
      success: true,
      message: "✅ Login successful!",
      session_token: sessionToken,
      business: {
        id:             biz.id,
        username:       biz.username,
        businessName:   biz.business_name,
        email:          biz.email,
        phone:          biz.phone,
        plan:           biz.plan,
        referralCode:   biz.referral_code,
        emailVerified:  biz.email_verified,
        phoneVerified:  biz.phone_verified,
        replyCount:     biz.reply_count,
        replyLimit:     biz.reply_limit,
        isTrial:        biz.is_trial,
        trialEndsAt:    biz.trial_ends_at,
        planLimits:     limits,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /auth/logout — Invalidate session
app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    await supabase.from("sessions").update({ is_active: false }).eq("id", req.session.id);
    res.json({ success: true, message: "✅ Logged out successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/logout-all — Logout from all devices
app.post("/auth/logout-all", requireAuth, async (req, res) => {
  try {
    await supabase.from("sessions").update({ is_active: false }).eq("business_id", req.business.id);
    res.json({ success: true, message: "✅ Logged out from all devices." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/verify-email — Verify with OTP
app.post("/auth/verify-email", requireAuth, async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: "OTP code is required." });

    const { data: otpRecord } = await supabase.from("otp_verifications")
      .select("*")
      .eq("identifier", req.business.email)
      .eq("type", "email_verify")
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!otpRecord) return res.status(400).json({ error: "OTP expired or not found. Request a new one." });
    if (otpRecord.otp_code !== otp) {
      await supabase.from("otp_verifications").update({ attempts: otpRecord.attempts + 1 }).eq("id", otpRecord.id);
      return res.status(400).json({ error: "Incorrect OTP code. Please try again." });
    }

    // Mark as verified
    await supabase.from("businesses").update({ email_verified: true }).eq("id", req.business.id);
    await supabase.from("otp_verifications").update({ used: true }).eq("id", otpRecord.id);

    res.json({ success: true, message: "✅ Email verified successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/resend-otp — Resend verification email
app.post("/auth/resend-otp", requireAuth, async (req, res) => {
  try {
    const otp = generateOTP();
    await supabase.from("otp_verifications").insert({ identifier: req.business.email, type: "email_verify", otp_code: otp });
    await sendOTPEmail(req.business.email, otp, "verify");
    res.json({ success: true, message: "✅ New verification code sent to your email." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/forgot-password
app.post("/auth/forgot-password", authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const { data: biz } = await supabase.from("businesses").select("id, email").eq("email", email.toLowerCase()).single();
    if (!biz) return res.status(404).json({ error: "No account found with that email." });

    const otp = generateOTP();
    await supabase.from("otp_verifications").insert({ identifier: email.toLowerCase(), type: "password_reset", otp_code: otp });
    await sendOTPEmail(email, otp, "reset");

    res.json({ success: true, message: "✅ Password reset code sent to your email." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/reset-password
app.post("/auth/reset-password", authLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ error: "Email, OTP, and new password are required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const { data: otpRecord } = await supabase.from("otp_verifications").select("*").eq("identifier", email.toLowerCase()).eq("type", "password_reset").eq("used", false).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).single();

    if (!otpRecord || otpRecord.otp_code !== otp) return res.status(400).json({ error: "Invalid or expired reset code." });

    await supabase.from("businesses").update({ password_hash: hashPassword(newPassword) }).eq("email", email.toLowerCase());
    await supabase.from("otp_verifications").update({ used: true }).eq("id", otpRecord.id);
    await supabase.from("sessions").update({ is_active: false }).eq("business_id", otpRecord.id);

    res.json({ success: true, message: "✅ Password reset successfully! Please log in with your new password." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me — Get current user info
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const biz    = req.business;
    const limits = PLAN_LIMITS[biz.plan] || PLAN_LIMITS.free;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", biz.id).single();
    const { data: stats }    = await supabase.from("business_dashboard").select("*").eq("id", biz.id).single();

    res.json({
      success: true,
      business: {
        id:             biz.id,
        username:       biz.username,
        businessName:   biz.business_name,
        businessDesc:   biz.business_desc,
        businessCategory: biz.business_category,
        email:          biz.email,
        phone:          biz.phone,
        contactPhone:   biz.contact_phone,
        contactEmail:   biz.contact_email,
        city:           biz.city,
        state:          biz.state,
        country:        biz.country,
        deliveryAreas:  biz.delivery_areas,
        deliveryFee:    biz.delivery_fee,
        deliveryDays:   biz.delivery_days,
        plan:           biz.plan,
        isTrial:        biz.is_trial,
        trialEndsAt:    biz.trial_ends_at,
        emailVerified:  biz.email_verified,
        phoneVerified:  biz.phone_verified,
        replyCount:     biz.reply_count,
        replyLimit:     biz.reply_limit,
        referralCode:   biz.referral_code,
        referralCount:  biz.referral_count,
        planLimits:     limits,
        settings:       settings,
        stats:          stats,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ═══════════════════════════════════════════════════════════
// ONBOARDING ROUTES (Business Setup Wizard)
// ═══════════════════════════════════════════════════════════
// ============================================================

// POST /onboarding/business-info — Step 1: Business details
app.post("/onboarding/business-info", requireAuth, async (req, res) => {
  try {
    const {
      businessName, businessDesc, businessCategory,
      contactPhone, contactEmail,
      address, city, state, country,
      deliveryAreas, deliveryFee, deliveryDays, freeDeliveryAbove,
    } = req.body;

    if (!businessName) return res.status(400).json({ error: "Business name is required." });

    await supabase.from("businesses").update({
      business_name:      businessName,
      business_desc:      businessDesc || null,
      business_category:  businessCategory || "general",
      contact_phone:      contactPhone || null,
      contact_email:      contactEmail || null,
      address:            address || null,
      city:               city || null,
      state:              state || null,
      country:            country || "Nigeria",
      delivery_areas:     deliveryAreas || [],
      delivery_fee:       parseFloat(deliveryFee) || 0,
      delivery_days:      deliveryDays || "1-3 business days",
      free_delivery_above: freeDeliveryAbove ? parseFloat(freeDeliveryAbove) : null,
      updated_at:         new Date().toISOString(),
    }).eq("id", req.business.id);

    res.json({ success: true, message: "✅ Business info saved! Proceed to add your products.", next_step: "add_products" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /onboarding/whatsapp — Step 2: Link WhatsApp
app.post("/onboarding/whatsapp", requireAuth, async (req, res) => {
  try {
    const { waPhoneId, waAccessToken, waBusinessId, paystackPublic, paystackSecret } = req.body;

    if (!waPhoneId || !waAccessToken) {
      return res.status(400).json({ error: "WhatsApp Phone ID and Access Token are required." });
    }

    await supabase.from("business_settings").update({
      wa_phone_id:      waPhoneId,
      wa_access_token:  waAccessToken,
      wa_business_id:   waBusinessId || null,
      paystack_public:  paystackPublic || null,
      paystack_secret:  paystackSecret || null,
      updated_at:       new Date().toISOString(),
    }).eq("business_id", req.business.id);

    // Also update whatsapp_number in businesses table
    await supabase.from("businesses").update({ updated_at: new Date().toISOString() }).eq("id", req.business.id);

    res.json({ success: true, message: "✅ WhatsApp connected! Your bot is now ready.", next_step: "customize_bot" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /onboarding/bot-messages — Step 3: Customize bot messages
app.post("/onboarding/bot-messages", requireAuth, async (req, res) => {
  try {
    const { greetingMsg, fallbackMsg, awayMsg, aiPersonality, customInstructions, businessHoursStart, businessHoursEnd, timezone } = req.body;

    await supabase.from("business_settings").update({
      greeting_msg:         greetingMsg || null,
      fallback_msg:         fallbackMsg || null,
      away_msg:             awayMsg || null,
      ai_personality:       aiPersonality || "friendly",
      custom_instructions:  customInstructions || null,
      business_hours_start: businessHoursStart || "08:00",
      business_hours_end:   businessHoursEnd || "20:00",
      timezone:             timezone || "Africa/Lagos",
      updated_at:           new Date().toISOString(),
    }).eq("business_id", req.business.id);

    res.json({ success: true, message: "✅ Bot messages customized!", next_step: "done" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /onboarding/status — Check what steps are complete
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
      bot_customized:     !!(settings?.greeting_msg !== "Hello! 👋 Welcome to our store! How can I help you today? Type *MENU* for options."),
    };

    const completed = Object.values(steps).filter(Boolean).length;
    const total     = Object.keys(steps).length;

    res.json({ success: true, steps, progress: `${completed}/${total}`, percent: Math.round((completed / total) * 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ═══════════════════════════════════════════════════════════
// PRODUCTS API (with Excel/CSV import)
// ═══════════════════════════════════════════════════════════
// ============================================================

// GET /api/products — List products
app.get("/api/products", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, search } = req.query;
    let query = supabase.from("products").select("*", { count: "exact" })
      .eq("business_id", req.business.id)
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (category) query = query.eq("category", category);
    if (search) query = query.ilike("name", `%${search}%`);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, products: data, total: count, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products — Add single product (checks plan limit)
app.post("/api/products", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;

    // Check product limit
    const { count } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    if (count >= limits.product_limit) {
      return res.status(403).json({
        error: `You've reached your ${req.business.plan} plan limit of ${limits.product_limit} products.`,
        upgrade_url: `${process.env.FRONTEND_URL}/pricing.html`,
      });
    }

    const { name, description, category, price, salePrice, currency, type, stock, lowStockAlert, digitalLink, digitalCode, imageUrl, keywords, tags, sku } = req.body;
    if (!name || !price) return res.status(400).json({ error: "Product name and price are required." });

    const { data, error } = await supabase.from("products").insert({
      business_id: req.business.id, sku: sku || null,
      name, description: description || null,
      category: category || "general",
      price: parseFloat(price), sale_price: salePrice ? parseFloat(salePrice) : null,
      currency: currency || "NGN", type: type || "physical",
      stock: stock !== undefined ? parseInt(stock) : null,
      low_stock_alert: lowStockAlert || 5,
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

// PATCH /api/products/:id — Update product
app.patch("/api/products/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("products")
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("business_id", req.business.id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, product: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id
app.delete("/api/products/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("products").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success: true, message: "Product deleted." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products/import — Excel/CSV bulk import (Growth+ only)
app.post("/api/products/import", requireAuth, requirePlan("excel_import"), async (req, res) => {
  try {
    // Expects JSON array (frontend converts Excel → JSON before sending)
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "No products data found. Please check your file format." });
    }

    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count: currentCount } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);
    const remainingSlots = limits.product_limit - (currentCount || 0);

    if (remainingSlots <= 0) {
      return res.status(403).json({ error: `Product limit (${limits.product_limit}) reached. Upgrade to add more.` });
    }

    // Create import record
    const { data: importRecord } = await supabase.from("bulk_imports").insert({
      business_id: req.business.id, type: "products",
      total_rows: products.length, status: "processing",
    }).select().single();

    const batchId   = importRecord.id;
    const toImport  = products.slice(0, remainingSlots);
    const errors    = [];
    const rows      = [];

    for (let i = 0; i < toImport.length; i++) {
      const p = toImport[i];
      // Validate required fields
      if (!p.name || !p.price) {
        errors.push({ row: i + 2, error: `Row ${i + 2}: name and price are required` });
        continue;
      }
      rows.push({
        business_id:   req.business.id,
        sku:           p.sku || null,
        name:          String(p.name).trim(),
        description:   p.description ? String(p.description).trim() : null,
        category:      p.category || "general",
        price:         parseFloat(p.price) || 0,
        sale_price:    p.sale_price ? parseFloat(p.sale_price) : null,
        currency:      p.currency || "NGN",
        type:          p.type || "physical",
        stock:         p.stock !== undefined && p.stock !== "" ? parseInt(p.stock) : null,
        digital_link:  p.digital_link || null,
        digital_code:  p.digital_code || null,
        image_url:     p.image_url || null,
        keywords:      p.keywords ? String(p.keywords).split(",").map(k => k.trim()) : [],
        tags:          p.tags ? String(p.tags).split(",").map(t => t.trim()) : [],
        imported_from: "excel",
        import_batch_id: batchId,
      });
    }

    let imported = 0;
    if (rows.length > 0) {
      const { data: inserted, error: insertErr } = await supabase.from("products").insert(rows).select();
      if (insertErr) throw insertErr;
      imported = inserted?.length || 0;
    }

    // Update import record
    await supabase.from("bulk_imports").update({
      imported_rows: imported, failed_rows: errors.length,
      errors: errors, status: "done", completed_at: new Date().toISOString(),
    }).eq("id", batchId);

    res.json({
      success: true,
      message: `✅ Import complete! ${imported} products added, ${errors.length} failed.`,
      imported, failed: errors.length, errors: errors.slice(0, 10), // show first 10 errors
      skipped: products.length > remainingSlots ? products.length - remainingSlots : 0,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/import/template — Download Excel template columns
app.get("/api/products/import/template", requireAuth, (req, res) => {
  res.json({
    success: true,
    message: "Use these column headers in your Excel/CSV file:",
    columns: [
      { header: "name",         required: true,  example: "Red Wig 24inch",     description: "Product name" },
      { header: "price",        required: true,  example: "15000",               description: "Price in your currency" },
      { header: "description",  required: false, example: "Beautiful human hair wig", description: "Product description" },
      { header: "category",     required: false, example: "fashion",             description: "Product category" },
      { header: "currency",     required: false, example: "NGN",                 description: "NGN, GHS, KES, or USD" },
      { header: "type",         required: false, example: "physical",            description: "physical or digital" },
      { header: "stock",        required: false, example: "50",                  description: "Stock quantity (leave blank for unlimited)" },
      { header: "sale_price",   required: false, example: "12000",               description: "Discounted price" },
      { header: "sku",          required: false, example: "WIG-001",             description: "Your stock code" },
      { header: "digital_link", required: false, example: "https://drive.google.com/...", description: "Download link (for digital products)" },
      { header: "digital_code", required: false, example: "LICENSE-ABC123",      description: "Access code (for digital products)" },
      { header: "keywords",     required: false, example: "wig,hair,fashion",    description: "Search keywords (comma separated)" },
      { header: "tags",         required: false, example: "featured,sale",       description: "Tags (comma separated)" },
      { header: "image_url",    required: false, example: "https://...",         description: "Product image URL" },
    ],
    instructions: [
      "1. Create an Excel or Google Sheets file",
      "2. Use the exact column headers above in Row 1",
      "3. Add your products from Row 2 onwards",
      "4. Export as CSV or convert to JSON",
      "5. Upload via the dashboard Import button",
    ],
  });
});

// ============================================================
// ═══════════════════════════════════════════════════════════
// DASHBOARD API (per-subscriber, plan-limited)
// ═══════════════════════════════════════════════════════════
// ============================================================

// GET /dashboard/stats — Overview stats
app.get("/dashboard/stats", requireAuth, async (req, res) => {
  try {
    const { data: stats, error } = await supabase.from("business_dashboard").select("*").eq("id", req.business.id).single();
    if (error) throw error;

    const limits = PLAN_LIMITS[req.business.id] || PLAN_LIMITS.free;
    const { data: errors } = await supabase.from("error_reports").select("id").eq("business_id", req.business.id).eq("resolved", false);

    res.json({
      success: true,
      stats: {
        ...stats,
        unresolved_errors: errors?.length || 0,
        plan_limits: PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/kb — Knowledge Base (plan-limited)
app.get("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { data, count, error } = await supabase.from("knowledge_base").select("*", { count: "exact" })
      .eq("business_id", req.business.id).order("uses", { ascending: false });
    if (error) throw error;

    res.json({
      success: true, entries: data, total: count,
      limit: limits.kb_limit,
      can_add: (count || 0) < limits.kb_limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dashboard/kb
app.post("/dashboard/kb", requireAuth, async (req, res) => {
  try {
    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { count } = await supabase.from("knowledge_base").select("id", { count: "exact", head: true }).eq("business_id", req.business.id);

    if ((count || 0) >= limits.kb_limit) {
      return res.status(403).json({ error: `KB limit (${limits.kb_limit}) reached. Upgrade to add more.`, upgrade_url: `${process.env.FRONTEND_URL}/pricing.html` });
    }

    const { keyword, answer, category, language } = req.body;
    if (!keyword || !answer) return res.status(400).json({ error: "Keyword and answer are required." });

    const { data, error } = await supabase.from("knowledge_base").insert({
      business_id: req.business.id, keyword, answer,
      category: category || "general", language: language || "en",
    }).select().single();
    if (error) throw error;

    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/kb/:id/toggle
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

// DELETE /dashboard/kb/:id
app.delete("/dashboard/kb/:id", requireAuth, async (req, res) => {
  try {
    await supabase.from("knowledge_base").delete().eq("id", req.params.id).eq("business_id", req.business.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/ai-logs — AI self-healing candidates
app.get("/dashboard/ai-logs", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("ai_promotion_candidates").select("*").eq("business_id", req.business.id).limit(50);
    if (error) throw error;
    res.json({ success: true, candidates: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dashboard/ai-logs/:id/promote — 1-click promote to KB
app.post("/dashboard/ai-logs/:id/promote", requireAuth, async (req, res) => {
  try {
    const { customAnswer, category, language } = req.body;
    const { data: log, error: logErr } = await supabase.from("ai_logs").select("*").eq("id", req.params.id).single();
    if (logErr || !log) return res.status(404).json({ error: "Log not found." });

    const { data: kbEntry, error: kbErr } = await supabase.from("knowledge_base").insert({
      business_id: log.business_id, keyword: log.incoming_msg.substring(0, 100),
      answer: customAnswer || log.ai_response, category: category || "general",
      language: language || "en", confidence: log.confidence || 0.85, promoted_from_ai: true,
    }).select().single();
    if (kbErr) throw kbErr;

    await supabase.from("ai_logs").update({ promoted_to_kb: true }).eq("id", req.params.id);
    res.json({ success: true, message: "✅ Promoted to KB!", kbEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/contacts — CRM (plan-limited)
app.get("/dashboard/contacts", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, tag, segment, search } = req.query;
    let query = supabase.from("contacts").select("*", { count: "exact" })
      .eq("business_id", req.business.id)
      .order("last_seen", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

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

// GET /dashboard/orders — Orders list
app.get("/dashboard/orders", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    let query = supabase.from("orders").select("*, contacts(name, phone)", { count: "exact" })
      .eq("business_id", req.business.id)
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status) query = query.eq("status", status);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ success: true, orders: data, total: count, page: Number(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/orders/:id — Update order status
app.patch("/dashboard/orders/:id", requireAuth, async (req, res) => {
  try {
    const { status, trackingNumber, notes } = req.body;
    const { data, error } = await supabase.from("orders").update({
      status: status || undefined, tracking_number: trackingNumber || undefined,
      notes: notes || undefined, updated_at: new Date().toISOString(),
    }).eq("id", req.params.id).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/broadcasts — Broadcasts (plan-limited)
app.get("/dashboard/broadcasts", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { data, error } = await supabase.from("broadcasts").select("*").eq("business_id", req.business.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, broadcasts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dashboard/broadcasts/send
app.post("/dashboard/broadcasts/send", requireAuth, requirePlan("broadcasts_enabled"), async (req, res) => {
  try {
    const { title, message, targetTags, targetSegment } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required." });

    const limits = PLAN_LIMITS[req.business.plan] || PLAN_LIMITS.free;
    const { data: settings } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (!settings?.wa_phone_id) return res.status(400).json({ error: "WhatsApp not configured. Please complete setup first." });

    let query = supabase.from("contacts").select("phone, name").eq("business_id", req.business.id).eq("opted_in", true);
    if (targetTags?.length) query = query.overlaps("tags", targetTags);
    if (targetSegment) query = query.eq("segment", targetSegment);
    const { data: contacts } = await query.limit(limits.broadcast_limit);

    if (!contacts?.length) return res.json({ success: false, message: "No contacts found matching your filters." });

    const { data: broadcast } = await supabase.from("broadcasts").insert({
      business_id: req.business.id, title: title || "Broadcast",
      message, target_tags: targetTags || [], recipients_count: contacts.length, status: "sending",
    }).select().single();

    const accessToken = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;
    let sent = 0, failed = 0;

    for (const contact of contacts) {
      try {
        const personalMsg = message.replace("{name}", contact.name || "Friend");
        await sendWhatsAppMessage(settings.wa_phone_id, accessToken, contact.phone, personalMsg);
        sent++; await sleep(300);
      } catch (e) { failed++; }
    }

    await supabase.from("broadcasts").update({ status: "sent", sent_count: sent, failed_count: failed, sent_at: new Date().toISOString() }).eq("id", broadcast.id);
    res.json({ success: true, sent, failed, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/referrals
app.get("/dashboard/referrals", requireAuth, async (req, res) => {
  try {
    const { data: referrals } = await supabase.from("referrals").select("*").eq("referrer_id", req.business.id).order("created_at", { ascending: false });
    res.json({
      success: true,
      referralCode: req.business.referral_code,
      referralLink: `${process.env.FRONTEND_URL}?ref=${req.business.referral_code}`,
      totalReferrals: req.business.referral_count || 0,
      referrals: referrals || [],
      rewards: { "3 referrals": "1 Month Growth FREE", "10 referrals": "Ambassador Status + 10% commission" },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/settings
app.get("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("business_settings").select("*").eq("business_id", req.business.id).single();
    if (error) throw error;
    // Hide sensitive tokens partially
    if (data?.wa_access_token) data.wa_access_token = data.wa_access_token.substring(0, 20) + "...";
    if (data?.paystack_secret) data.paystack_secret = "sk_***hidden***";
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/settings
app.patch("/dashboard/settings", requireAuth, async (req, res) => {
  try {
    const allowed = ["greeting_msg", "fallback_msg", "away_msg", "auto_reply", "ai_enabled", "collect_leads", "watermark", "away_mode", "business_hours_start", "business_hours_end", "timezone", "notify_new_order", "notify_payment", "notify_email", "ai_personality", "custom_instructions"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("business_settings").update(updates).eq("business_id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/profile — Update business profile
app.patch("/dashboard/profile", requireAuth, async (req, res) => {
  try {
    const allowed = ["business_name", "business_desc", "business_category", "contact_phone", "contact_email", "address", "city", "state", "country", "delivery_areas", "delivery_fee", "delivery_days", "free_delivery_above"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from("businesses").update(updates).eq("id", req.business.id).select().single();
    if (error) throw error;
    res.json({ success: true, business: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /dashboard/change-password
app.patch("/dashboard/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both current and new password are required." });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });

    if (req.business.password_hash !== hashPassword(currentPassword)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    await supabase.from("businesses").update({ password_hash: hashPassword(newPassword) }).eq("id", req.business.id);
    await supabase.from("sessions").update({ is_active: false }).eq("business_id", req.business.id).neq("id", req.session.id);

    res.json({ success: true, message: "✅ Password changed! Other sessions have been logged out." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================

async function sendWhatsAppMessage(phoneNumberId, accessToken, to, message) {
  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
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
  const { data: entries } = await supabase.from("knowledge_base").select("*").eq("business_id", businessId).eq("is_active", true).in("language", [language, "en"]);
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
  if (!HF_TOKEN) throw new Error("HF key not set");

  const personality = settings?.ai_personality || "friendly";
  const custom      = settings?.custom_instructions || "";

  const systemPrompt = `You are a ${personality} WhatsApp sales assistant for "${business.business_name}", an African business.
Business: ${business.business_desc || "We sell quality products and services."}
Location: ${business.city || ""} ${business.country || "Nigeria"}
Delivery: ${business.delivery_days || "1-3 business days"} | Fee: ${business.currency || "NGN"} ${business.delivery_fee || 0}
${custom ? `Special instructions: ${custom}` : ""}
Rules:
- Keep replies SHORT (under 100 words)
- Be ${personality} and warm, use 1-2 emojis
- End with a clear CTA (Reply ORDER, Type MENU, etc.)
- Never make up prices — say "Type CATALOG for prices"
- Customer intent: ${intent}
- Language: ${language === "pidgin" ? "Nigerian Pidgin" : language === "yo" ? "Yoruba-friendly English" : language === "ha" ? "Hausa-friendly English" : language === "ig" ? "Igbo-friendly English" : "English"}`;

  const start = Date.now();
  const response = await axios.post(`${HF_API}${HF_MODEL}`,
    { inputs: `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${message}<|im_end|>\n<|im_start|>assistant\n`,
      parameters: { max_new_tokens: 150, temperature: 0.7, top_p: 0.9, return_full_text: false } },
    { headers: { Authorization: `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" }, timeout: 25000 }
  );

  let text = "";
  if (Array.isArray(response.data) && response.data[0]?.generated_text) text = response.data[0].generated_text.trim();
  else if (response.data?.generated_text) text = response.data.generated_text.trim();
  text = text.replace(/<\|im_end\|>/g, "").replace(/<\|im_start\|>/g, "").trim();
  if (!text) throw new Error("Empty AI response");

  return { text, latency: Date.now() - start, tokens: text.split(" ").length };
}

// GET — WhatsApp webhook verification
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST — Incoming WhatsApp messages
app.post("/webhook/whatsapp", async (req, res) => {
  res.sendStatus(200);
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

    // Find business by WhatsApp Phone Number ID
    const { data: settings } = await supabase.from("business_settings").select("*, businesses(*)").eq("wa_phone_id", waPhoneNumberId).single();
    if (!settings?.businesses) { console.warn(`⚠️ No business for WA ID: ${waPhoneNumberId}`); return; }

    const business     = settings.businesses;
    const plan         = business.plan || "free";
    const planLimits   = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const accessToken  = settings.wa_access_token || process.env.WA_ACCESS_TOKEN;
    const addWatermark = !planLimits.remove_watermark;

    if (!settings.auto_reply) return;

    // Check reply limit
    const used = business.reply_count || 0, limit = business.reply_limit || 100;
    if (plan !== "pro" && used >= limit) {
      let msg2 = `⚠️ This business has reached its monthly reply limit. Please contact them directly.`;
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, msg2); return;
    }

    // Get or create contact
    let contact;
    const { data: existingContact } = await supabase.from("contacts").select("*").eq("business_id", business.id).eq("phone", fromPhone).single();
    if (existingContact) {
      contact = existingContact;
      await supabase.from("contacts").update({ last_seen: new Date().toISOString() }).eq("id", contact.id);
    } else {
      const { data: newC } = await supabase.from("contacts").insert({ business_id: business.id, phone: fromPhone, name: contactName }).select().single();
      contact = newC;
    }

    const language = detectLanguage(messageText);
    const intent   = detectIntent(messageText);

    const buildReply = (text) => addWatermark ? text + WATERMARK : text;

    // ── MENU ──
    if (/^(menu|help|start|options?)$/i.test(messageText.trim())) {
      const reply = buildReply(
        `🤖 *${business.business_name} — Menu*\n\n` +
        `🛍️ *CATALOG* — See our products\n` +
        `💰 *PRICE* — Get pricing info\n` +
        `📦 *TRACK [order no]* — Track order\n` +
        `📞 *CONTACT* — Talk to our team\n` +
        `🚀 *ORDER [product]* — Place an order\n\n` +
        `Or just type your question! 😊`
      );
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, reply);
      await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
      return;
    }

    // ── CATALOG ──
    if (/^(catalog|products?|shop|browse|list|price|how much)$/i.test(messageText.trim())) {
      const { data: products } = await supabase.from("products").select("name, price, currency, sale_price, type, description").eq("business_id", business.id).eq("is_active", true).limit(10);
      let cat = `🛒 *${business.business_name} — Products*\n\n`;
      if (products?.length) {
        products.forEach((p, i) => {
          const displayPrice = p.sale_price ? `~~${p.currency} ${Number(p.price).toLocaleString()}~~ ${p.currency} ${Number(p.sale_price).toLocaleString()} 🔥` : `${p.currency} ${Number(p.price).toLocaleString()}`;
          cat += `${i + 1}. *${p.name}*\n   💰 ${displayPrice}\n`;
          if (p.description) cat += `   ${p.description.substring(0, 60)}\n`;
          cat += `   ${p.type === "digital" ? "⚡ Digital" : "📦 Physical"}\n\n`;
        });
        cat += `Reply *ORDER [product name]* to buy!`;
      } else {
        cat += `No products listed yet. Type *CONTACT* to ask! 😊`;
      }
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(cat));
      await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
      return;
    }

    // ── CONTACT ──
    if (/^(contact|support|human|agent|talk)$/i.test(messageText.trim())) {
      const contactInfo = business.contact_phone || business.phone;
      const reply = buildReply(
        `📞 *Contact ${business.business_name}*\n\n` +
        `Phone/WhatsApp: ${contactInfo}\n` +
        `${business.contact_email ? `Email: ${business.contact_email}\n` : ""}` +
        `${business.city ? `Location: ${business.city}, ${business.state || business.country}\n` : ""}` +
        `\nWe respond within 2 hours! 😊`
      );
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, reply);
      await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
      return;
    }

    // ── DELIVERY ──
    if (/^(delivery|deliver|shipping|ship)$/i.test(messageText.trim())) {
      const areas = business.delivery_areas?.length ? business.delivery_areas.join(", ") : "Nationwide";
      const reply = buildReply(
        `📦 *Delivery Information*\n\n` +
        `📍 We deliver to: ${areas}\n` +
        `⏱️ Delivery time: ${business.delivery_days || "1-3 business days"}\n` +
        `💰 Delivery fee: ${business.currency || "NGN"} ${Number(business.delivery_fee || 0).toLocaleString()}\n` +
        `${business.free_delivery_above ? `🎁 FREE delivery on orders above ${business.currency || "NGN"} ${Number(business.free_delivery_above).toLocaleString()}\n` : ""}` +
        `\nType *ORDER [product]* to place your order! 🛍️`
      );
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, reply);
      await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
      return;
    }

    // ── TRACK ──
    if (/^(track|status)\s+\S+/i.test(messageText.trim())) {
      const orderRef = messageText.trim().split(/\s+/).slice(1).join(" ");
      const { data: order } = await supabase.from("orders").select("*").eq("business_id", business.id).eq("contact_id", contact.id).or(`order_number.ilike.%${orderRef}%,id.ilike.${orderRef}%`).single();
      if (order) {
        const reply = buildReply(
          `📍 *Order Status*\n\n🆔 ${order.order_number}\n📦 Status: *${order.status.toUpperCase()}*\n💳 Payment: ${order.paystack_status}\n📅 Ordered: ${new Date(order.created_at).toLocaleDateString()}\n${order.tracking_number ? `🚚 Tracking: ${order.tracking_number}\n` : ""}\nType *CONTACT* for help! 😊`
        );
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, reply);
        await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
        return;
      }
    }

    // ── ORDER ──
    if (/^order\s+.+/i.test(messageText.trim())) {
      const productQuery = messageText.replace(/^order\s+/i, "").trim();
      const { data: prods } = await supabase.from("products").select("*").eq("business_id", business.id).eq("is_active", true);
      let matched = null;
      if (prods) for (const p of prods) { if (fuzzyMatch(productQuery, p.name) > 0.5) { matched = p; break; } }
      if (matched) {
        const subtotal    = matched.sale_price || matched.price;
        const deliveryFee = matched.type === "digital" ? 0 : (business.delivery_fee || 0);
        const total       = subtotal + deliveryFee;
        const { data: order } = await supabase.from("orders").insert({
          business_id: business.id, contact_id: contact.id,
          order_number: `ORD-${Date.now().toString(36).toUpperCase()}`,
          items: [{ product_id: matched.id, name: matched.name, qty: 1, price: subtotal, currency: matched.currency }],
          subtotal, delivery_fee: deliveryFee, total, currency: matched.currency || "NGN",
          delivery_type: matched.type, status: "pending",
        }).select().single();

        // Create payment link
        let payLink = "";
        try {
          const secret = settings.paystack_secret || process.env.PAYSTACK_SECRET_KEY;
          const resp = await axios.post("https://api.paystack.co/transaction/initialize",
            { email: contact.email || `${fromPhone.replace("+", "")}@vendrai.app`, amount: total * 100, currency: matched.currency || "NGN",
              reference: `VND-${order.id.substring(0, 8).toUpperCase()}`,
              metadata: { order_id: order.id, business_id: business.id, contact_phone: fromPhone },
              callback_url: `${process.env.BACKEND_URL}/webhook/paystack/verify` },
            { headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } }
          );
          payLink = resp.data?.data?.authorization_url || "";
          await supabase.from("orders").update({ payment_link: payLink }).eq("id", order.id);
        } catch (e) { console.error("Paystack error:", e.message); }

        const reply = buildReply(
          `✅ *Order Created!*\n\n📦 ${matched.name}\n💰 ${matched.currency} ${Number(subtotal).toLocaleString()}\n🚚 Delivery: ${matched.currency} ${Number(deliveryFee).toLocaleString()}\n💵 *Total: ${matched.currency} ${Number(total).toLocaleString()}*\n🆔 ${order.order_number}\n\n${payLink ? `👇 *Pay securely here:*\n${payLink}\n\n` : ""}⚡ Digital products delivered instantly after payment!`
        );
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, reply);
        await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
        return;
      }
    }

    // ── KNOWLEDGE BASE ──
    const kbMatch = await searchKnowledgeBase(business.id, messageText, language);
    if (kbMatch) {
      await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(kbMatch.answer));
      await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
      await supabase.from("ai_logs").insert({ business_id: business.id, contact_phone: fromPhone, incoming_msg: messageText, ai_response: kbMatch.answer, kb_hit: true, kb_entry_id: kbMatch.id, status: "success", confidence: kbMatch.matchScore });
      return;
    }

    // ── AI (QWEN) — last resort ──
    if (settings.ai_enabled !== false && planLimits.ai_enabled) {
      try {
        const aiResult = await callQwenAI(messageText, business, language, intent, settings);
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(aiResult.text));
        await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
        await supabase.from("ai_logs").insert({ business_id: business.id, contact_phone: fromPhone, incoming_msg: messageText, ai_response: aiResult.text, kb_hit: false, model_used: "qwen", latency_ms: aiResult.latency, status: "success", confidence: 0.85 });
        return;
      } catch (aiErr) {
        console.error("❌ AI failed:", aiErr.message);
        const fallback = settings.fallback_msg || `Thanks for your message! 😊 Type *MENU* for options or *CONTACT* to reach our team.`;
        await sendWhatsAppMessage(waPhoneNumberId, accessToken, fromPhone, buildReply(fallback));
        await supabase.from("businesses").update({ reply_count: used + 1 }).eq("id", business.id);
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
    if (event.event === "charge.success") {
      const meta    = event.data.metadata;
      const orderId = meta?.order_id, bizId = meta?.business_id, phone = meta?.contact_phone;
      if (!orderId) return res.sendStatus(200);

      await supabase.from("orders").update({ paystack_status: "success", paystack_ref: event.data.reference, paid_at: new Date().toISOString(), status: "paid", updated_at: new Date().toISOString() }).eq("id", orderId);
      await supabase.from("payments").insert({ business_id: bizId, order_id: orderId, type: "order", amount: event.data.amount / 100, currency: event.data.currency, paystack_ref: event.data.reference, paystack_txn_id: String(event.data.id), status: "success" });

      // Auto-deliver digital products
      if (phone) {
        const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
        if (order?.delivery_type === "digital" && !order.digital_sent) {
          const { data: bizSettings } = await supabase.from("business_settings").select("*").eq("business_id", bizId).single();
          if (bizSettings) {
            let msg = `🎉 *Payment Confirmed!*\n\n✅ ${order.order_number} is paid!\n\n📥 *Your Product:*\n`;
            for (const item of (order.items || [])) {
              const { data: p } = await supabase.from("products").select("digital_link, digital_code").eq("id", item.product_id).single();
              if (p?.digital_link) msg += `🔗 ${p.digital_link}\n`;
              if (p?.digital_code) msg += `🔑 Code: ${p.digital_code}\n`;
            }
            msg += `\nThank you! 🙏 Type *MENU* to shop again.`;
            await sendWhatsAppMessage(bizSettings.wa_phone_id, bizSettings.wa_access_token || process.env.WA_ACCESS_TOKEN, phone, msg);
            await supabase.from("orders").update({ digital_sent: true, digital_sent_at: new Date().toISOString(), status: "delivered" }).eq("id", orderId);
          }
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
    const prices   = { starter: 4900, growth: 14900, pro: 29900 };
    if (!prices[plan]) return res.status(400).json({ error: "Invalid plan. Choose: starter, growth, or pro." });

    const response = await axios.post("https://api.paystack.co/transaction/initialize",
      { email: req.business.email, amount: prices[plan] * 100, currency: "NGN",
        reference: `SUB-${req.business.id.substring(0, 8)}-${Date.now()}`,
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
// HEALTH & ROOT
// ============================================================

app.get("/health", (req, res) => {
  res.json({ status: "✅ VendrAI v2.0 is running", version: "2.0.0", timestamp: new Date().toISOString(), uptime: Math.floor(process.uptime()), features: ["multi-tenant", "auth", "onboarding", "excel-import", "per-plan-limits"] });
});

app.get("/", (req, res) => {
  res.json({ app: "VendrAI", version: "2.0.0", status: "🟢 Live", tagline: "AI WhatsApp Automation for African SMEs" });
});

app.use((req, res) => res.status(404).json({ error: "Route not found", path: req.path }));
app.use((err, req, res, next) => { console.error("💥", err.message); res.status(500).json({ error: "Internal server error" }); });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 VendrAI v2.0 running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health\n`);
});

module.exports = app;
