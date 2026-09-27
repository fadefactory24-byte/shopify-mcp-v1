-- Default runtime settings. Edit values in Supabase Table Editor; the app
-- re-reads them every ~60s (no redeploy needed).
insert into settings (key, value, description) values
  ('bot_enabled', 'true', 'Master switch. false = AI stops replying (messages are still stored).'),
  ('business_hours', '{"timezone":"Asia/Jerusalem","days":{"sun":["09:00","18:00"],"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","13:00"],"sat":null}}', 'Staff availability, used to set expectations on handoff.'),
  ('persona_notes', '"Warm, short, helpful. Talk like a friendly Israeli store rep who is also a parent. Never pushy."', 'Extra tone guidance appended to the business prompt layer.'),
  ('handoff_expectation', '{"ar":"راح يرد عليك حدا من الفريق بأقرب وقت 🙏","he":"נציג מהצוות יחזור אלייך בהקדם 🙏","en":"Someone from our team will get back to you shortly 🙏"}', 'Fallback text used when the AI cannot produce a reply.'),
  ('unsupported_media_reply', '{"ar":"حالياً بقدر أساعدك بالرسائل المكتوبة بس 🙏 اكتبلي شو بتحتاج؟","he":"כרגע אני יכול לעזור רק בהודעות כתובות 🙏 מה צריך?","en":"For now I can only help with text messages 🙏 What do you need?"}', 'Reply to voice/image/video messages until media understanding is enabled.')
on conflict (key) do nothing;

-- Knowledge-base templates. They are INACTIVE until the owner fills real
-- content and sets is_active = true. Refund/shipping/terms policies are read
-- live from Shopify (keys policy.refund / policy.shipping / policy.terms), so
-- they don't need to be duplicated here.
insert into kb_articles (key, category, title, content, language, is_active) values
  ('payment.methods', 'payment', 'Payment methods / אמצעי תשלום', 'TODO: list accepted payment methods (credit cards, Bit, PayPal, installments...)', 'he', false),
  ('shipping.cost', 'shipping', 'Shipping cost & free-shipping threshold / עלות משלוח', 'TODO: shipping price and free-shipping threshold, if any', 'he', false),
  ('contact.hours', 'contact', 'Contact & support hours / שעות שירות', 'TODO: support email/phone and hours', 'he', false),
  ('promotions.current', 'promotions', 'Current promotions / מבצעים', 'TODO: current bundle deals / coupon rules. Deactivate when the promotion ends.', 'he', false)
on conflict (key) do nothing;
