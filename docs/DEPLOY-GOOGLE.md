# النشر على Google Cloud — Unlimited Study

> تم تحت إنتاج Unlimited Team

## المعمارية (كل حاجة دائمة ومُدارة)

```
المتصفح ──HTTPS──▶ Cloud Run (حاويات بدون حالة، بتتوسّع تلقائياً)
                      ├──▶ Cloud SQL for PostgreSQL 16   ← الطلاب، الجلسات، السجلات، المحتوى (نسخ احتياطي يومي + استرجاع لأي لحظة)
                      ├──▶ Cloud Storage (bucket خاص)    ← ملفات المحاضرات/السكاشن (النسخ بتتحفظ، مفيش رابط عام)
                      └──▶ Secret Manager                ← SESSION_SECRET / ADMIN_PASSWORD / DATABASE_URL
```
- **مفيش أي بيانات على الحاوية**: لو Cloud Run مسح الحاوية أو شغّل 10 نسخ، مفيش حاجة بتضيع ولا بتتعارض.
- الجلسات، الـ lockouts، وحدود المعدل (rate limit) كلها في PostgreSQL، فمشتركة بين كل النسخ.
- لوحة المشرف المباشرة بين النسخ بتشتغل عبر `LISTEN/NOTIFY`.
- الملفات مش بتتقدّم برابط عام أبداً: كل تحميل بيعدّي على السيرفر (تسجيل دخول + تسجيل في اللوجز) ويدعم Range لتشغيل الفيديو.

## الخطوات (حوالي 15 دقيقة، أغلبها انتظار Cloud SQL)
1. أنشئ مشروع في [Google Cloud Console](https://console.cloud.google.com) وفعّل **الفوترة (Billing)**.
2. افتح **Cloud Shell** (أيقونة الـ terminal فوق) وارفع المشروع (أو `git clone`).
3. شغّل:
```bash
PROJECT_ID=اسم-مشروعك \
ADMIN_EMAIL=ايميلك@gmail.com \
ADMIN_PASSWORD='كلمة-سر-قوية-10-حروف-أو-أكتر' \
bash deploy/gcp-setup.sh
```
السكربت بيعمل: تفعيل الـ APIs ← Artifact Registry ← Cloud SQL (Postgres 16 + نسخ احتياطي يومي + PITR + حماية من الحذف) ← bucket خاص بـ versioning ← حساب خدمة بأقل صلاحيات ← الأسرار ← البناء والنشر. آخر سطر بيطبعلك رابط المنصة.
4. افتح الرابط وادخل بـ «دخول المشرف التنفيذي». **أول تشغيل بيجهّز قاعدة البيانات والطلاب (384) والمواد تلقائياً.**
5. (اختياري) **Google Sign-In:** أنشئ OAuth Client (Web) وضيف رابط المنصة في *Authorized JavaScript origins*، بعدين:
   `gcloud run services update unlimited-study --region europe-west1 --update-env-vars GOOGLE_CLIENT_ID=<id>`
6. (اختياري) **دومين خاص:** `gcloud run domain-mappings create --service unlimited-study --domain study.yourdomain.com --region europe-west1` واتبع تعليمات الـ DNS.

> **مهم:** السكربت **ما اتجرّبش على حساب Google حقيقي** (مفيش وصول من بيئتي). الأوامر مراجعة صياغةً (`bash -n`) والكود اللي بيشتغل عليه (PostgreSQL، المهاجرات، التخزين، التزامن) متجرّب فعلياً — شوف «ما اتجرّب» تحت. لو أمر فشل، الرسالة هتقولك أي API/صلاحية ناقصة؛ ابعتها وأصلحها.

## التحديثات اللاحقة
`gcloud builds submit --config cloudbuild.yaml --substitutions _SQL_INSTANCE=<PROJECT:REGION:INSTANCE>,_BUCKET=<bucket>,_ADMIN_EMAIL=<email>` أو اربط الريبو بـ Cloud Build Trigger. المهاجرات (تعديلات الجداول) بتتطبّق تلقائياً وبأمان حتى لو أكتر من نسخة اتشغّلت مع بعض.
الرجوع لنسخة قديمة: Cloud Run → Revisions → Manage traffic.

## النسخ الاحتياطي والاسترجاع
- **قاعدة البيانات:** نسخة يومية 2 صباحاً (آخر 14) + استرجاع لأي لحظة (PITR). استرجاع: `gcloud sql instances clone unlimited-study-db restored-db --point-in-time '2026-11-14T10:00:00Z'`.
- **الملفات:** الـ bucket عليه versioning؛ الملف المحذوف غلط ممكن يتسترجع من النسخ القديمة (`gcloud storage ls -a gs://BUCKET`).
- جرّب الاسترجاع مرة قبل ما تحتاجه.

## الحدود والتكلفة (بصراحة)
| الموضوع | التفاصيل |
|---|---|
| **حجم الرفع** | Cloud Run بيرفض أي طلب فوق **32MB**، فالافتراضي هنا 30MB. فيديوهات أكبر محتاجة رفع مباشر للـ bucket بروابط موقّعة (signed URLs) — **مش مبني**. ارفع الفيديوهات الكبيرة على YouTube (غير مدرجة) وحط الرابط في الوصف |
| **التكلفة التقريبية** | Cloud SQL `db-g1-small` ≈ 30–40$/شهر، Cloud Run مع `min-instances=1` ≈ 10–20$، التخزين والشبكة قروش لعدد طلاب كهذا. لتوفير: شيل `--min-instances=1` (أول زيارة بعد خمول هتبقى أبطأ) |
| **الاتصالات** | `max-instances(10) × DB_POOL_MAX(5)` لازم تبقى أقل من `max_connections` في Cloud SQL |
| **المنطقة** | `europe-west1` افتراضياً. لو عايز أقرب لمصر جرّب `europe-west8`/`me-central1` (تحقق من توفر Cloud SQL) |
| **الحماية** | HTTPS تلقائي، الكوكيز Secure، الأسرار في Secret Manager، الـ bucket خاص (public access prevention)، حساب الخدمة بأقل صلاحيات |

## التشغيل المحلي (نفس القاعدة الحقيقية)
```bash
cp .env.example .env        # حط SESSION_SECRET و ADMIN_PASSWORD
docker compose up --build   # PostgreSQL 16 + التطبيق → http://localhost:3000
```
أو من غير Docker: ثبّت PostgreSQL، أنشئ قاعدة، حط `DATABASE_URL` في `.env`، ثم `npm ci && npm start`.
الاختبارات: `npm test` (بيشغّل PostgreSQL مدمج تلقائياً كمستخدم عادي) أو `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test`.

## ما اتجرّب فعلاً (وما لم يُجرَّب)
**اتجرّب (71 اختبار + متصفح حقيقي):** كل الواجهات على PostgreSQL 18 حقيقي (10 صفحات، 0 مخالفة وصول، 0 أخطاء Console)؛ المهاجرات بالتزامن؛ lockouts ذرّية تحت ضغط متوازي؛ rate limit مشترك بين نسختين؛ جلسة بتشتغل على نسخة تانية؛ البث المباشر بين نسختين عبر LISTEN/NOTIFY؛ رفع/تنزيل/حذف الملفات عبر درايفر Cloud Storage (ضد نسخة وهمية في الذاكرة من عميل GCS)؛ Range للفيديو؛ تنظيف الملفات اليتيمة عند فشل الرفع؛ `/readyz`؛ رفض التخزين المحلي على Cloud Run؛ boot متزامن لـ3 نسخ.
**لم يُجرَّب:** الاتصال بـ Cloud SQL وCloud Storage وSecret Manager الحقيقيين، سكربت `gcp-setup.sh` و`cloudbuild.yaml` على حساب Google فعلي، بناء الـ Docker image (مفيش Docker daemon عندي)، اختبار حِمل (load test).
