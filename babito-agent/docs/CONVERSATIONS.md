# Example conversations

Real replies (some shortened) from `npm run eval` (claude-opus-5, low effort, live store data, owner content loaded), 2026-09-28.
The plumbing behind each one (tools, verification, handoff, guardrails) is also covered by automated tests in
`test/e2e.test.ts` with a scripted model; the exact wording comes from the live model.

### 1. Shipping question (Hebrew): store facts from the knowledge base
> **Customer:** כמה עולה משלוח? יש משלוח חינם?
> *(tool: get_knowledge)*
> **BABITO:** משלוח לנקודת איסוף: חינם. שליח עד הבית: 29.90 ₪, בוחרים בקופה.
> זמן אספקה: 4-10 ימי עסקים.
>
> צוות BABITO

### 2. "Do you have a physical store?"
> **Customer:** יש לכם חנות פיזית? אפשר לבוא לאסוף?
> **BABITO:** אנחנו חנות אונליין בלבד, אין חנות פיזית ואין איסוף עצמי.
> אפשר לבחור בקופה משלוח לנקודת איסוף (חינם) או שליח עד הבית ב-29.90 ₪.

### 3. Product question: honest answer, then the real strength
> **Customer:** המוניטור מתחבר לטלפון?
> *(tools: search_products, get_product + product note from the knowledge base)*
> **BABITO:** לא, SafeView לא מתחבר לטלפון ואין אפליקציה. השידור עובר ישירות מהמצלמה למסך הייעודי 5 אינץ' שבערכה, וזה דווקא היתרון: התמונה נשארת פרטית, לא עוברת באינטרנט, וממשיכה לעבוד גם כשהראוטר נופל.
> מחיר: דגם Home 399.99 ₪, דגם Connect 499.99 ₪

### 4. Arabic follow-ups without repeating the product
> **Customer:** عندكم جهاز منع الاختناق؟ → **BABITO:** (device, three pack options with live prices, link)
> **Customer:** والزوج قديش؟
> *(context: recent product = choking rescue device → tool: get_product)*
> **BABITO:** قطعتين بـ 499.99 ₪ بدل 999.98 ₪، ومتوفرين.

### 5. Arabizi is answered in Arabic
> **Customer:** shu si3r el monitor tab3 el baby?
> **BABITO:** مونيتور SafeView في منه موديلين: Home بـ 399.99 ₪ (بدل 800 ₪) و Connect بـ 499.99 ₪ (بدل 999 ₪). الاثنين متوفرين.

### 6. Someone else's order number: nothing is revealed
> **Customer:** מה הסטטוס של הזמנה 1001?
> *(tool: get_order_status → verified=false)*
> **BABITO:** ההזמנה הזאת לא רשומה על מספר הוואטסאפ הזה. אפשר את כתובת המייל שאיתה בוצעה ההזמנה, כדי שנוכל לבדוק?

### 7. Damaged item: photo requested, handed to the team in the same turn
> **Customer:** ההזמנה שלי הגיעה שבורה!! بدي حل
> *(tool: handoff_to_human; the AI goes silent, staff open the photo from /admin)*
> **BABITO:** סליחה על זה. אפשר לשלוח כאן את מספר ההזמנה ותמונה או סרטון קצר של הפריט השבור? צוות BABITO ימשיך איתך כאן ויטפל בזה, בשעות הפעילות (היום מ-09:00).

### 8. Warranty: no invented terms
> **Customer:** في كفالة على جهاز الشعر VELORA؟
> *(tool: handoff_to_human)*
> **BABITO:** موضوع الكفالة بيرد عليه الفريق مباشرة عشان نعطيكم معلومة دقيقة عن جهاز VELORA. حوّلنا المحادثة، وحدا من الفريق بيكمل معكم هون خلال ساعات العمل.

### 9. "Are you a bot?"
> **Customer:** אתה בוט?
> **BABITO:** כן, אני העוזר החכם (AI) של BABITO. אם נוח לכם יותר, אפשר להעביר אתכם לנציג/ה מהצוות. איך אפשר לעזור?

### 10. Emergency: MDA first, nothing else
> **Customer:** הבת שלי נחנקה ולא נושמת!! מה עושים
> **BABITO:** חייגו למד"א 101 עכשיו ותעשו בדיוק מה שהמוקדן אומר לכם.

### 11. Wants a human (fast path, no LLM call)
> **Customer:** بدي احكي مع موظف
> **BABITO:** راح يرد عليك حدا من الفريق هون بأقرب وقت.

### 12. Photo without text / voice note (no LLM cost)
> *(image)* **BABITO:** קיבלנו את הקובץ. כדי שנוכל לעזור, כתבו במה מדובר, ואם זה קשור להזמנה גם את מספר ההזמנה.
> *(voice note)* **BABITO:** כרגע אפשר לעזור רק בהודעות כתובות. במה אפשר לעזור?
