#!/usr/bin/env bash
# One-time infrastructure for Unlimited Study on Google Cloud: Cloud SQL (PostgreSQL 16), Cloud Storage bucket, Secret Manager,
# Artifact Registry, a least-privilege service account — then the first deploy.
# Run it from the project root in Cloud Shell (https://shell.cloud.google.com) or any machine with gcloud logged in:
#   PROJECT_ID=my-project ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at-least-10-chars' bash deploy/gcp-setup.sh
# Re-running is safe: existing resources are reused. NOTE: this script has not been run against a live Google account by its author.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"; : "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD (10+ chars)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-unlimited-study}"
SQL_INSTANCE="${SQL_INSTANCE:-unlimited-study-db}"
SQL_TIER="${SQL_TIER:-db-g1-small}"                 # db-custom-1-3840 or larger for real traffic
DB_NAME="${DB_NAME:-unlimited_study}"; DB_USER="${DB_USER:-study}"
BUCKET="${BUCKET:-${PROJECT_ID}-${SERVICE}-files}"
REPO="${REPO:-$SERVICE}"
SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"
[ "${#ADMIN_PASSWORD}" -ge 10 ] || { echo "ADMIN_PASSWORD must be 10+ chars"; exit 1; }

gcloud config set project "$PROJECT_ID" >/dev/null
echo "▶ enabling APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com

echo "▶ Artifact Registry"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION"

echo "▶ Cloud SQL (PostgreSQL 16) — takes several minutes the first time"
if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$SQL_TIER" --region "$REGION" \
    --storage-auto-increase --backup-start-time=02:00 --enable-point-in-time-recovery --retained-backups-count=14 \
    --availability-type=zonal --deletion-protection
fi
gcloud sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" >/dev/null 2>&1 || gcloud sql databases create "$DB_NAME" --instance "$SQL_INSTANCE"
DB_PASS="$(openssl rand -hex 24)"                    # hex => safe inside a URL
if gcloud sql users list --instance "$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  gcloud sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$DB_PASS"
else
  gcloud sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$DB_PASS"
fi
CONN="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"

echo "▶ Cloud Storage bucket (private, uniform access, versioned)"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$BUCKET" --versioning

echo "▶ Service account (least privilege)"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create "${SERVICE}-run" --display-name "Unlimited Study (Cloud Run)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role roles/cloudsql.client --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectUser >/dev/null

echo "▶ Secrets"
put_secret() {   # name, value (never echoed)
  gcloud secrets describe "$1" >/dev/null 2>&1 || gcloud secrets create "$1" --replication-policy=automatic
  printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
}
gcloud secrets describe study-session-secret >/dev/null 2>&1 || put_secret study-session-secret "$(openssl rand -hex 48)"   # keep the existing one: rotating it logs everybody out
gcloud secrets add-iam-policy-binding study-session-secret --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
put_secret study-admin-password "$ADMIN_PASSWORD"
put_secret study-database-url "postgres://${DB_USER}:${DB_PASS}@/${DB_NAME}?host=/cloudsql/${CONN}"

echo "▶ Build + deploy"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser roles/logging.logWriter; do   # let Cloud Build deploy
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role "$role" --condition=None >/dev/null
done
gcloud builds submit --config cloudbuild.yaml \
  --substitutions "_REGION=$REGION,_SERVICE=$SERVICE,_REPO=$REPO,_SQL_INSTANCE=$CONN,_BUCKET=$BUCKET,_ADMIN_EMAIL=$ADMIN_EMAIL"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo; echo "✔ Live at: $URL"
echo "  • Sign in as the supervisor with $ADMIN_EMAIL and the password you set."
echo "  • Google Sign-In: add $URL to 'Authorized JavaScript origins' of your OAuth client, then set GOOGLE_CLIENT_ID:"
echo "      gcloud run services update $SERVICE --region $REGION --update-env-vars GOOGLE_CLIENT_ID=<id>"
