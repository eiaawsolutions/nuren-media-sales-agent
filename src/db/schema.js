import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export function initializeDatabase(db) {
  db.exec(`
    -- ==========================================================
    -- USERS & SESSIONS (multi-user, EIAAW-pattern)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('superadmin','user')),
      display_name TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended')),
      mfa_secret TEXT,
      mfa_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ==========================================================
    -- SETTINGS (encrypted values via utils/crypto)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ==========================================================
    -- ACCOUNTS & LEADS
    -- Account = company. Lead = person at that company.
    -- One account -> many leads (marketing mgr + brand mgr + founder etc).
    -- Verification fields are first-class columns (NOT folded into notes)
    -- per Global Lead Gen Contract — makes the server-side gate explicit.
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      website TEXT,
      industry TEXT,                      -- FMCG / Healthcare / Education / Ecommerce (canonical segment)
      sub_industry TEXT,                  -- baby / beauty / wellness / maternity / family services / etc.
      geography TEXT,                     -- MY / SG / TH / APAC / Global
      employee_range TEXT,                -- SME / mid-market / enterprise
      estimated_budget_tier TEXT CHECK(estimated_budget_tier IN ('starter','mid','enterprise','unknown')) DEFAULT 'unknown',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      account_id INTEGER,

      -- Identity
      name TEXT NOT NULL,
      title TEXT,
      email TEXT,                         -- verified only; '' if unverified (never guessed)
      phone TEXT,                         -- publicly listed only
      other_contact TEXT,                 -- free-form (e.g. "WeChat: ...")

      -- Canonical persona + segment (drives AI prompt selection)
      persona TEXT CHECK(persona IN ('marketing_manager','brand_manager','digital_marketer','founder','unknown')) DEFAULT 'unknown',
      type TEXT CHECK(type IN ('B2B','B2C','B2B2C')) DEFAULT 'B2B',

      -- Temperature + fit
      lead_type TEXT CHECK(lead_type IN ('hot','cold')) DEFAULT 'cold',
      confidence_score TEXT CHECK(confidence_score IN ('high','medium','low')) DEFAULT 'medium',
      score INTEGER DEFAULT 0,            -- 0-100 numeric, derived from fit + intent

      -- Verification (per Global Lead Gen Contract) — required by server-side gate
      linkedin_url TEXT,
      company_website TEXT,
      verification_sources TEXT,          -- JSON array of URLs (>=1 required)
      reason_for_fit TEXT,
      buying_signal TEXT,                 -- required when lead_type = 'hot'
      enrichment TEXT,                    -- JSON blob of enrichment data

      -- Pipeline (relationship state, separate from deal pipeline stage)
      status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','engaged','qualified','proposal','closed_won','closed_lost','unsubscribed','bounced')),
      source TEXT DEFAULT 'csv_upload',   -- csv_upload / ai_enrichment / linkedin / meta / shopee / lazada / event / manual

      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id);
    CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_user_email ON leads(user_id, email) WHERE email != '';

    CREATE TABLE IF NOT EXISTS leads_rejected (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      raw_input TEXT NOT NULL,            -- JSON of what was submitted
      reasons TEXT NOT NULL,              -- JSON array of reason strings
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_leads_rejected_user ON leads_rejected(user_id);

    -- ==========================================================
    -- CAMPAIGNS & SEQUENCES (multi-step outreach with A/B)
    -- Campaign = strategic container (e.g. "FMCG baby skincare Q2 push")
    -- Sequence = cadence template (Day 1 -> Day 3 -> Day 6 -> Day 10)
    -- Enrollment = one lead going through one sequence
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      objective TEXT CHECK(objective IN ('awareness','consideration','conversion')) DEFAULT 'consideration',
      target_industry TEXT,               -- FMCG / Healthcare / Education / Ecommerce
      target_persona TEXT,                -- marketing_manager / brand_manager / ...
      target_budget_tier TEXT CHECK(target_budget_tier IN ('starter','mid','enterprise','any')) DEFAULT 'any',
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','scheduled','active','paused','completed','stopped')),
      budget_limit REAL DEFAULT 0,        -- AI cost cap in USD
      pitch_angle TEXT,                   -- e.g. 'community_trust' / 'kol_network' / 'affiliate_commerce'
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);

    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sequence_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_id INTEGER NOT NULL,
      step_number INTEGER NOT NULL,       -- 1, 2, 3, 4
      delay_days INTEGER NOT NULL,        -- 0 (Day 1), 2 (Day 3), 5 (Day 6), 9 (Day 10)
      channel TEXT NOT NULL CHECK(channel IN ('email','linkedin_dm','whatsapp')),
      goal TEXT NOT NULL,                 -- 'intro_value_hook' / 'case_study' / 'social_proof' / 'soft_close'
      subject_template TEXT,              -- email only; AI fills {{placeholders}}
      body_template TEXT NOT NULL,        -- AI fills {{placeholders}}
      variant_key TEXT DEFAULT 'A',       -- A / B for A/B testing
      FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,
      UNIQUE (sequence_id, step_number, variant_key)
    );

    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      sequence_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      variant_key TEXT DEFAULT 'A',
      current_step INTEGER DEFAULT 0,     -- 0 = not started
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','paused','replied','completed','unsubscribed','bounced','failed')),
      started_at DATETIME,
      paused_reason TEXT,
      last_action_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (sequence_id) REFERENCES sequences(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      UNIQUE (campaign_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS idx_enroll_campaign ON sequence_enrollments(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_enroll_lead ON sequence_enrollments(lead_id);
    CREATE INDEX IF NOT EXISTS idx_enroll_status ON sequence_enrollments(status);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_id INTEGER,
      lead_id INTEGER NOT NULL,
      campaign_id INTEGER,
      direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
      channel TEXT NOT NULL CHECK(channel IN ('email','linkedin_dm','whatsapp')),
      step_number INTEGER,
      variant_key TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      external_id TEXT,                   -- Resend email id / platform msg id
      status TEXT DEFAULT 'queued' CHECK(status IN ('queued','sent','delivered','opened','clicked','replied','bounced','failed','drafted')),
      scheduled_at DATETIME,
      sent_at DATETIME,
      opened_at DATETIME,
      clicked_at DATETIME,
      replied_at DATETIME,
      classification TEXT,                -- set by reply-handler: positive / objection / not_now / unsubscribe
      objection_tag TEXT,                 -- no_budget / has_agency / send_proposal / not_relevant / other
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (enrollment_id) REFERENCES sequence_enrollments(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id);
    CREATE INDEX IF NOT EXISTS idx_msg_enroll ON messages(enrollment_id);
    CREATE INDEX IF NOT EXISTS idx_msg_scheduled ON messages(scheduled_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS idx_msg_external ON messages(external_id);

    -- ==========================================================
    -- PIPELINE (deal state, separate from lead.status)
    -- 6-stage spec: Prospect -> Contacted -> Engaged -> Qualified -> Proposal Sent -> Closed
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS pipeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      account_id INTEGER,
      stage TEXT NOT NULL CHECK(stage IN ('prospect','contacted','engaged','qualified','proposal_sent','closed_won','closed_lost')),
      deal_value_myr REAL DEFAULT 0,
      probability INTEGER DEFAULT 0,
      expected_close_date DATE,
      inventory_interest TEXT,            -- JSON array of kb_asset tags the lead is interested in
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_user ON pipeline(user_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline(stage);

    -- ==========================================================
    -- ACTIVITIES (audit trail)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lead_id INTEGER,
      account_id INTEGER,
      campaign_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('email_sent','email_opened','email_clicked','email_replied','email_bounced','linkedin_drafted','whatsapp_drafted','meeting_booked','meeting_held','pipeline_advance','lead_enriched','lead_rejected','note','task','ai_action','unsubscribe')),
      description TEXT NOT NULL,
      outcome TEXT,
      meta TEXT,                          -- JSON blob
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
    CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);

    -- ==========================================================
    -- APPOINTMENTS (auto Meet link + branded call.html)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lead_id INTEGER,
      title TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      duration_minutes INTEGER DEFAULT 30,
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','confirmed','completed','cancelled','no_show')),
      type TEXT DEFAULT 'discovery' CHECK(type IN ('discovery','pitch','proposal_review','follow_up')),
      meet_link TEXT,
      call_token TEXT UNIQUE,             -- random token for branded call.html landing
      notes TEXT,
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments(user_id);
    CREATE INDEX IF NOT EXISTS idx_appt_token ON appointments(call_token);

    -- ==========================================================
    -- KNOWLEDGE BASE — the Nuren AI brain's RAG corpus
    -- kb_assets  = 1 row per source PPTX (with ingest status + visual-pass cost)
    -- kb_slides  = 1 row per slide, linked to asset, stores raw extracted text + vision summary
    -- kb_chunks  = retrievable units (chunks of a slide's text+summary merged)
    -- kb_chunks_vec = sqlite-vec virtual table for embeddings
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS kb_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      title TEXT,
      brand TEXT,                         -- MMY / KMM / MSG / Nuren21 / Ibuencer / Kelabmama / Parentcraft / Cross
      asset_type TEXT,                    -- rate_card / media_kit / case_study / event_deck / survey / sponsorship
      target_industry TEXT,               -- FMCG / Healthcare / Education / Ecommerce / Any
      target_objective TEXT,              -- awareness / consideration / conversion / any
      budget_tier TEXT,                   -- starter / mid / enterprise / any
      sha256 TEXT,                        -- dedupe by file hash
      slide_count INTEGER DEFAULT 0,
      ingest_status TEXT DEFAULT 'pending' CHECK(ingest_status IN ('pending','parsing','vision','embedding','completed','failed')),
      ingest_error TEXT,
      vision_cost_usd REAL DEFAULT 0,
      embedding_cost_usd REAL DEFAULT 0,
      ingested_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kb_slides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      slide_number INTEGER NOT NULL,
      raw_text TEXT,                      -- verbatim XML text extraction
      speaker_notes TEXT,
      vision_summary TEXT,                -- Claude Vision's description of the slide image(s)
      vision_rates_json TEXT,             -- structured rate/number extraction for rate-card slides (JSON)
      image_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id) REFERENCES kb_assets(id) ON DELETE CASCADE,
      UNIQUE (asset_id, slide_number)
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      slide_id INTEGER,                   -- nullable for cross-slide summary chunks
      slide_number INTEGER,
      chunk_type TEXT CHECK(chunk_type IN ('text','vision','merged','rates','summary')) DEFAULT 'merged',
      brand TEXT,
      asset_type TEXT,
      target_industry TEXT,
      target_objective TEXT,
      budget_tier TEXT,
      content TEXT NOT NULL,              -- the retrievable text
      token_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (asset_id) REFERENCES kb_assets(id) ON DELETE CASCADE,
      FOREIGN KEY (slide_id) REFERENCES kb_slides(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_asset ON kb_chunks(asset_id);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_brand ON kb_chunks(brand);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_industry ON kb_chunks(target_industry);

    -- FTS5 for keyword/hybrid search (the 'vision_rates_json' column is NOT indexed,
    -- we rely on the merged 'content' column for keyword hits).
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      content,
      brand,
      asset_type,
      target_industry,
      content=kb_chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, content, brand, asset_type, target_industry)
      VALUES (new.id, new.content, new.brand, new.asset_type, new.target_industry);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, brand, asset_type, target_industry)
      VALUES('delete', old.id, old.content, old.brand, old.asset_type, old.target_industry);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, content, brand, asset_type, target_industry)
      VALUES('delete', old.id, old.content, old.brand, old.asset_type, old.target_industry);
      INSERT INTO kb_chunks_fts(rowid, content, brand, asset_type, target_industry)
      VALUES (new.id, new.content, new.brand, new.asset_type, new.target_industry);
    END;

    -- Vector index (sqlite-vec). 1024-dim matches Voyage-style embeddings;
    -- we use Claude-compatible embedding via Voyage or fallback text-embedding model.
    -- Keep dim in one place: if it changes, drop+recreate this table.
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[1024]
    );

    -- ==========================================================
    -- PERSONA + OBJECTION BRAIN (seeded, editable via Settings UI)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS personas (
      key TEXT PRIMARY KEY,               -- marketing_manager / brand_manager / digital_marketer / founder
      display_name TEXT NOT NULL,
      description TEXT,
      pain_points TEXT NOT NULL,          -- JSON array
      decision_drivers TEXT NOT NULL,     -- JSON array
      preferred_angle TEXT,               -- community_trust / kol_network / affiliate_commerce / full_funnel
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS segments (
      key TEXT PRIMARY KEY,               -- fmcg / healthcare / education / ecommerce
      display_name TEXT NOT NULL,
      description TEXT,
      pain_points TEXT NOT NULL,          -- JSON array
      relevant_brands TEXT NOT NULL,      -- JSON array of Nuren brand keys
      preferred_angle TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS objections (
      key TEXT PRIMARY KEY,               -- no_budget / has_agency / send_proposal / not_relevant / other
      display_name TEXT NOT NULL,
      pattern_regex TEXT,                 -- optional regex used by reply-handler classification
      response_strategy TEXT NOT NULL,    -- human-readable strategy
      example_response TEXT,              -- gold-standard response the AI anchors to
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS brand_inventory (
      key TEXT PRIMARY KEY,               -- mmy / kmm / msg / nuren21 / ibuencer / kelabmama / parentcraft
      display_name TEXT NOT NULL,
      tagline TEXT,
      reach TEXT,                         -- human-readable reach stat
      strengths TEXT NOT NULL,            -- JSON array
      best_fit_industries TEXT NOT NULL,  -- JSON array
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ==========================================================
    -- CONNECTORS (Phase-2 wiring, UI scaffolded in MVP)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS connectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('linkedin_sales_nav','meta_ad_library','shopee','lazada','event_list')),
      display_name TEXT,
      status TEXT DEFAULT 'disconnected' CHECK(status IN ('disconnected','connected','error')),
      credentials TEXT,                   -- encrypted JSON
      last_sync_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE (user_id, provider)
    );

    -- ==========================================================
    -- AI COST LOG (per-call tracking, per-campaign budget guard)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS ai_cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      campaign_id INTEGER,
      task_type TEXT NOT NULL,            -- enrichment / draft_email / classify_reply / vision_ingest / embed / chat
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      web_search_requests INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cost_user ON ai_cost_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_cost_campaign ON ai_cost_log(campaign_id);

    -- ==========================================================
    -- EMAIL EVENTS (Resend webhooks)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,                   -- Resend email id
      event_type TEXT NOT NULL,           -- sent / delivered / opened / clicked / bounced / complained
      payload TEXT,                       -- JSON
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_email_events_ext ON email_events(external_id);
  `);

  // ------------------------------------------------------------
  // Seed default settings
  // ------------------------------------------------------------
  const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get();
  if (settingsCount.c === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    ins.run('ai_provider', 'anthropic');
    ins.run('ai_model_default', 'claude-sonnet-4-6');
    ins.run('ai_model_objection', 'claude-opus-4-7');
    ins.run('ai_model_enrichment', 'claude-haiku-4-5-20251001');
    ins.run('ai_model_vision', 'claude-sonnet-4-6');
    ins.run('embedding_provider', 'voyage');
    ins.run('embedding_model', 'voyage-3-lite');
    ins.run('embedding_dim', '1024');
    ins.run('api_key', '');
    ins.run('voyage_api_key', '');
    ins.run('resend_api_key', '');
    ins.run('from_email', 'Nuren Media <sales@nurengroup.com>');
    ins.run('company_name', 'Nuren Group');
    ins.run('tone_policy', 'empowering|community_first|maternal_brand_safe|never_corporate_salesy');
    ins.run('positioning_moat', 'community_trust+kol_network+affiliate_commerce');
    ins.run('hybrid_mode', '1');          // AI qualifies, human closes
  }

  // ------------------------------------------------------------
  // Seed first superadmin if users table empty
  // ------------------------------------------------------------
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (userCount.c === 0) {
    const defaultPassword = crypto.randomBytes(12).toString('hex');
    const hash = bcrypt.hashSync(defaultPassword, 10);
    db.prepare(
      "INSERT INTO users (username, email, password_hash, role, display_name, status) VALUES (?, ?, ?, 'superadmin', ?, 'active')"
    ).run('admin', 'eiaawsolutions@gmail.com', hash, 'Nuren Admin');
    console.log('\n==============================================');
    console.log('FIRST-RUN: superadmin created.');
    console.log(`  username: admin`);
    console.log(`  password: ${defaultPassword}`);
    console.log('  CHANGE IMMEDIATELY after first login.');
    console.log('==============================================\n');
  }

  // ------------------------------------------------------------
  // Seed Nuren brain (personas / segments / objections / brand_inventory)
  // Only seeds if tables are empty; edits via UI persist.
  // ------------------------------------------------------------
  seedNurenBrain(db);
}

function seedNurenBrain(db) {
  const personaCount = db.prepare('SELECT COUNT(*) as c FROM personas').get().c;
  if (personaCount === 0) {
    const ins = db.prepare(
      'INSERT INTO personas (key, display_name, description, pain_points, decision_drivers, preferred_angle) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ins.run(
      'marketing_manager',
      'Marketing Manager',
      'Owns marketing plan execution; reports to Head of Marketing or CMO; manages agency roster and media budgets.',
      JSON.stringify([
        'Paid media ROI is flattening — CPMs up, conversion down',
        'Struggling to prove incremental lift beyond last-click',
        'Boss asks for new audience channels every quarter',
        'Current KOL rosters are expensive and don\'t convert',
      ]),
      JSON.stringify(['proof_of_ROI', 'audience_relevance', 'easy_to_explain_upwards', 'low_implementation_risk']),
      'full_funnel'
    );
    ins.run(
      'brand_manager',
      'Brand Manager',
      'Owns brand health + specific product line; obsessed with brand equity + NPS; cautious about what brand is associated with.',
      JSON.stringify([
        'Brand-safety concerns when buying cheap inventory',
        'Need trusted voices who match brand values (mother-first, honest, caring)',
        'Hard to find genuine community built around category (not demo-only)',
        'Content must feel native, not like an ad',
      ]),
      JSON.stringify(['brand_safety', 'authenticity', 'community_fit', 'storytelling_quality']),
      'community_trust'
    );
    ins.run(
      'digital_marketer',
      'Digital / Performance Marketer',
      'Owns paid channel performance (Meta/Google/TikTok); measures CPA + ROAS daily; allergic to anything that cannot be tracked.',
      JSON.stringify([
        'CPM inflation on Meta + TikTok eating margin',
        'iOS14/privacy has broken conversion attribution',
        'Hungry for incremental trackable channels',
        'KOLs usually = vanity metrics, no conversion data',
      ]),
      JSON.stringify(['measurable_CPA', 'attribution_clarity', 'volume_at_price', 'ad_credit_style_economics']),
      'affiliate_commerce'
    );
    ins.run(
      'founder',
      'Founder (SME / DTC)',
      'Wears every hat; budget-conscious; wants compounding channels not one-off spends; values integrated solutions.',
      JSON.stringify([
        'Tiny budget, no patience for vanity spend',
        'Agencies are too expensive and slow',
        'Need one partner across content + influencer + sales',
        'Desperate to reach real mothers, not bot traffic',
      ]),
      JSON.stringify(['integrated_ecosystem', 'performance_tied_pricing', 'speed_to_launch', 'trusted_audience']),
      'full_funnel'
    );
  }

  const segCount = db.prepare('SELECT COUNT(*) as c FROM segments').get().c;
  if (segCount === 0) {
    const ins = db.prepare(
      'INSERT INTO segments (key, display_name, description, pain_points, relevant_brands, preferred_angle) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ins.run(
      'fmcg',
      'FMCG (Baby / Beauty / Wellness)',
      'Fast-moving consumer brands in baby care, beauty, or wellness categories.',
      JSON.stringify([
        'Shelf-competition brutal; need trial-driving content',
        'Parent buyers research online before purchase — need trusted reviews',
        'Sampling programs underutilized; hard to measure impact',
        'Shopee/Lazada CAC rising; need top-of-funnel that converts down-funnel',
      ]),
      JSON.stringify(['mmy', 'kmm', 'ibuencer', 'parentcraft']),
      'community_trust'
    );
    ins.run(
      'healthcare',
      'Healthcare & Maternity',
      'Clinics, hospitals, OB-GYN practices, maternity product brands, pre/post-natal health services.',
      JSON.stringify([
        'Regulated category — generic ads feel untrustworthy',
        'Expecting mothers seek community endorsement before booking',
        'Medical authority + mother-to-mother trust both matter',
        'Long consideration cycle needs nurture not one-shot ads',
      ]),
      JSON.stringify(['mmy', 'kmm', 'parentcraft']),
      'community_trust'
    );
    ins.run(
      'education',
      'Education & Family Services',
      'Enrichment classes, schools, daycares, family product/services (insurance, banking for families).',
      JSON.stringify([
        'Decision is high-stakes and emotional; generic ads miss',
        'Moms consult each other in communities before enrolling',
        'Need long content (articles, webinars) — not just 15s video',
        'Events / demos convert best but expensive to fill',
      ]),
      JSON.stringify(['mmy', 'kmm', 'parentcraft', 'kelabmama']),
      'full_funnel'
    );
    ins.run(
      'ecommerce',
      'E-commerce Brands (DTC / Marketplace)',
      'Pure-play ecommerce brands on Shopee/Lazada/own-site; often SME-scale; performance-focused.',
      JSON.stringify([
        'CPM inflation killing ROAS on Meta/TikTok',
        'Affiliate networks have low-intent creators',
        'Need creators + commerce integration, not just posts',
        'Hungry for performance-based media buys',
      ]),
      JSON.stringify(['mmy', 'ibuencer']),
      'affiliate_commerce'
    );
  }

  const objCount = db.prepare('SELECT COUNT(*) as c FROM objections').get().c;
  if (objCount === 0) {
    const ins = db.prepare(
      'INSERT INTO objections (key, display_name, pattern_regex, response_strategy, example_response) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run(
      'no_budget',
      'No budget / no money',
      '(no budget|tight budget|no money|can\\\'t afford|frozen budget|spending freeze)',
      'Never concede the deal. Pivot to a performance-based affiliate pilot (commission only) or a low-cost community content sampling — both leverage Nuren inventory without upfront cash. Reframe as "we get paid when you get paid".',
      'Completely fair — most brands we start with say the same in Q1. That\'s why we run a performance-only affiliate pilot via Ibuencer + Motherhood commerce — zero upfront, we earn when you do. Takes 30 mins to scope. Worth a short call?'
    );
    ins.run(
      'has_agency',
      'Already working with an agency',
      '(already.*agency|have.*agency|working with|partnered)',
      'Position as complementary, not replacement. Agencies lack owned community + first-party parenting audience. Offer to be the "audience + conversion layer" behind their creative.',
      'That makes total sense — and honestly, we work best alongside agencies, not instead of them. They handle creative; we plug in the parenting community + KOL conversion layer they don\'t own. A lot of our best accounts came in as "just the audience". Open to a 15-min call to see if there\'s an overlap?'
    );
    ins.run(
      'send_proposal',
      'Just send a proposal / media kit',
      '(send.*proposal|send.*deck|send.*media kit|send.*pricing|email.*rates)',
      'Refuse to send a blind proposal — it lands in archive. Ask 2-3 qualifying questions (objective, timing, current audience gap) then offer to send a *tailored* proposal. Preserves value perception.',
      'Happy to — but our generic kit lands in most inboxes and gets ignored, so we\'d rather send the 2-3 pages that fit your next campaign. Quick: are you focused on awareness, trial, or conversion this half? And which SKU / line would we be supporting?'
    );
    ins.run(
      'not_relevant',
      'Not relevant / wrong audience',
      '(not relevant|not our audience|not a fit|not for us|wrong audience)',
      'Never argue. Reframe with an audience insight that challenges the assumption (e.g. "the highest-intent beauty buyer right now is the 28-42 mom with disposable income, which is exactly our core"). Offer proof with a survey stat from the Digital Mum Survey.',
      'Totally hear you — and honestly this is the most common hidden-fit segment we see. Our latest Digital Mum survey shows {{stat}} — moms 28-42 are actually the highest-LTV segment for {{category}} right now. Worth a 10-min look before you rule it out?'
    );
    ins.run(
      'other',
      'Other / unclassified',
      null,
      'Acknowledge, ask one clarifying question to get to the real objection underneath, then bridge back to the best Nuren angle for their persona.',
      'Appreciate the honesty — can I ask what would need to be true for this to be worth a conversation?'
    );
  }

  const brandCount = db.prepare('SELECT COUNT(*) as c FROM brand_inventory').get().c;
  if (brandCount === 0) {
    const ins = db.prepare(
      'INSERT INTO brand_inventory (key, display_name, tagline, reach, strengths, best_fit_industries) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ins.run('mmy', 'Motherhood Malaysia (MMY)', 'The parenting platform Malaysia\'s mothers trust', '5M+ users across MY/SG/TH', JSON.stringify(['editorial content','community','commerce','KOL','events','video']), JSON.stringify(['fmcg','healthcare','education','ecommerce']));
    ins.run('kmm', 'Kelab Mama Malaysia (KMM)', 'The community where Malaysian mothers gather, share, and buy', 'Active parenting community', JSON.stringify(['community_threads','word_of_mouth','surveys','sampling']), JSON.stringify(['fmcg','healthcare','education']));
    ins.run('msg', 'Motherhood Singapore (MSG)', 'Singapore mothers, Singapore relevance', 'SG parenting audience', JSON.stringify(['editorial','KOL','community']), JSON.stringify(['fmcg','healthcare','education','ecommerce']));
    ins.run('nuren21', 'Nuren 21', 'Next-gen parenting content network', 'Cross-MY/SG/TH expansion', JSON.stringify(['cross_border_content','growth_editorial']), JSON.stringify(['fmcg','ecommerce']));
    ins.run('ibuencer', 'Ibuencer', 'Malaysia\'s first parenting KOL marketplace', 'Vetted parenting KOL roster', JSON.stringify(['KOL_matching','creator_briefs','campaign_reporting','affiliate_integration']), JSON.stringify(['fmcg','ecommerce','healthcare']));
    ins.run('kelabmama', 'Kelab Mama (community)', 'The forum + superapp for mothers', 'Engaged forum members', JSON.stringify(['UGC','surveys','trial_squads']), JSON.stringify(['fmcg','healthcare','education']));
    ins.run('parentcraft', 'Parentcraft', 'Live parenting education + workshops', 'School + workshop reach', JSON.stringify(['workshops','school_outreach','long_form_education']), JSON.stringify(['education','healthcare','fmcg']));
  }
}
