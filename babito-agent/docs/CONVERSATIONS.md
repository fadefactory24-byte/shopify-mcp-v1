# Example conversations

These show the intended behaviour. Each one is covered by an automated test in
`test/e2e.test.ts` (with a scripted model), so the *plumbing* (tools, verification,
handoff, guardrails) is proven; the exact wording comes from the live model.

### 1. Product question (Arabic) → live Shopify data
> **Customer:** عندكم جهاز منع الاختناق؟
> *(tool: search_products "מכשיר חנק anti choking")*
> **BABITO:** أكيد! عنا جهاز إنقاذ من الاختناق للأطفال والكبار، سعره 299.99 شيكل 👍 https://mybabito.com/products/…

### 2. Follow-up without repeating the product
> **Customer:** بكم؟ (or: والزوج؟)
> *(context: recent product = anti-choking device → tool: get_product)*
> **BABITO:** الجهاز الواحد بـ 299.99 شيكل، والزوج بـ 499.99 شيكل.

### 3. Stock question (Hebrew) — availability, never quantities
> **Customer:** יש במלאי את המכשיר נגד חנק?
> **BABITO:** יחידה אחת וזוג זמינים, המארז של 3 כרגע לא זמין.

### 4. Order tracking, mixed language
> **Customer:** وين طلبي אחי
> *(tool: get_my_orders — matched by the WhatsApp number)*
> **BABITO:** طلبك #1001 انبعت مع Israel Post، رقم التتبع RR123456789IL.

### 5. Someone else's order number
> **Customer:** מה הסטטוס של הזמנה 2002?
> *(tool: get_order_status → verified=false, no details returned)*
> **BABITO:** כדי לבדוק, מה כתובת המייל שאיתה בוצעה ההזמנה?
> **Customer:** other@example.com → *(verified)* → ההזמנה בטיפול ועוד לא נשלחה.

### 6. Address change — no false promises
> **Customer:** بدي أغير العنوان لطلب 1001
> *(tool: request_order_change → order not shipped → high-priority handoff; AI goes silent)*
> **BABITO:** حولت طلبك للفريق وراح يأكدولك هون 🙏

### 7. Wants a human
> **Customer:** נציג בבקשה / بدي احكي مع موظف
> *(fast path, no LLM call)*
> **BABITO:** راح يرد عليك حدا من الفريق بأقرب وقت 🙏

### 8. Shipping question → store policy, not the model's memory
> **Customer:** יש משלוח חינם?
> *(tool: get_knowledge ["shipping.cost","policy.shipping"])*
> If the KB has no answer: "אבדוק עם הצוות ואחזור אלייך" + handoff — never a guessed number.

### 9. Store system down
> **Customer:** عندكم كرسي أكل للأطفال؟
> *(Shopify unavailable → tool error)*
> **BABITO:** ما بقدر أفحص هلأ للأسف، بدك أحولك لحدا من الفريق؟

### 10. Hallucination caught
Model drafts "الجهاز سعره 150 شيكل" without calling a tool → guardrail rejects (150 was not returned by any tool) → model calls `get_product` → sends "299.99 شيكل". If it fails twice, the customer gets the fallback text and a human is assigned.

### 11. Voice note
> *(audio message)*
> **BABITO:** حالياً بقدر أساعدك بالرسائل المكتوبة بس 🙏 اكتبلي شو بتحتاج؟ *(no LLM cost)*
