#!/usr/bin/env bash
# Развёртывание архива в Yandex Cloud: 2 бакета Object Storage + Cloud Function.
#
#   ./deploy.sh <имя>            например: ./deploy.sh my-archive
#
# Нужны: yc (CLI Yandex Cloud, выполнен `yc init`), curl ≥ 7.75, zip, jq.
# Пароль на загрузку: переменная UPLOAD_PASSWORD (25 символов) или будет сгенерирован.
# Повторный запуск безопасен — обновит функцию и файлы интерфейса.
set -euo pipefail

NAME="${1:?Укажите имя архива латиницей, например: ./deploy.sh my-archive}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$ ]] || { echo "Имя: строчные латинские буквы, цифры и дефис"; exit 1; }
for t in yc curl zip jq; do command -v "$t" >/dev/null || { echo "Не найдена программа: $t"; exit 1; }; done

cd "$(dirname "$0")"
UI_BUCKET="$NAME"
SITES_BUCKET="$NAME-sites"
UI_URL="https://$UI_BUCKET.website.yandexcloud.net"
SITES_URL="https://$SITES_BUCKET.website.yandexcloud.net"
SA_NAME="$NAME-fn"
FN_NAME="$NAME-api"
SECRET_NAME="$NAME-secrets"
STATE=".deploy-$NAME.json"   # ключи и пароль — НЕ коммитить (есть в .gitignore)

FOLDER_ID="$(yc config get folder-id)"
echo "Каталог: $FOLDER_ID"

# ---------- бакеты ----------
for B in "$UI_BUCKET" "$SITES_BUCKET"; do
  if ! yc storage bucket get --name "$B" >/dev/null 2>&1; then
    echo "Создаю бакет $B"
    yc storage bucket create --name "$B" --default-storage-class standard --public-read >/dev/null
  fi
  yc storage bucket update --name "$B" --public-read \
    --website-settings '{"index": "index.html"}' >/dev/null
done
yc storage bucket update --name "$SITES_BUCKET" \
  --cors "allowed-methods=[method-get,method-put,method-head],allowed-origins=[$UI_URL],allowed-headers=[*],max-age-seconds=3600" >/dev/null

# ---------- сервисный аккаунт и статический ключ ----------
SA_ID="$(yc iam service-account get --name "$SA_NAME" --format json 2>/dev/null | jq -r .id || true)"
if [ -z "$SA_ID" ]; then
  echo "Создаю сервисный аккаунт $SA_NAME"
  SA_ID="$(yc iam service-account create --name "$SA_NAME" --format json | jq -r .id)"
  yc resource-manager folder add-access-binding "$FOLDER_ID" --role storage.editor --subject "serviceAccount:$SA_ID" >/dev/null
  yc resource-manager folder add-access-binding "$FOLDER_ID" --role lockbox.payloadViewer --subject "serviceAccount:$SA_ID" >/dev/null
fi

if [ ! -f "$STATE" ]; then
  echo "Создаю статический ключ доступа и пароль"
  KEY_JSON="$(yc iam access-key create --service-account-id "$SA_ID" --format json)"
  PASS="${UPLOAD_PASSWORD:-$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url').slice(0,25))" 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 25)}"
  jq -n --arg k "$(jq -r .access_key.key_id <<<"$KEY_JSON")" --arg s "$(jq -r .secret <<<"$KEY_JSON")" --arg p "$PASS" \
    '{access_key_id:$k, secret_access_key:$s, upload_password:$p}' > "$STATE"
  chmod 600 "$STATE"
fi
AK="$(jq -r .access_key_id "$STATE")"
SK="$(jq -r .secret_access_key "$STATE")"
PASS="$(jq -r .upload_password "$STATE")"
[ "${#PASS}" -eq 25 ] || { echo "Пароль в $STATE должен быть длиной 25 символов"; exit 1; }

# ---------- секрет Lockbox ----------
PAYLOAD="$(jq -cn --arg k "$AK" --arg s "$SK" --arg p "$PASS" \
  '[{key:"ACCESS_KEY_ID",text_value:$k},{key:"SECRET_ACCESS_KEY",text_value:$s},{key:"UPLOAD_PASSWORD",text_value:$p}]')"
SECRET_ID="$(yc lockbox secret get --name "$SECRET_NAME" --format json 2>/dev/null | jq -r .id || true)"
if [ -z "$SECRET_ID" ]; then
  echo "Создаю секрет $SECRET_NAME"
  SECRET_ID="$(yc lockbox secret create --name "$SECRET_NAME" --payload "$PAYLOAD" --format json | jq -r .id)"
else
  yc lockbox secret add-version --id "$SECRET_ID" --payload "$PAYLOAD" >/dev/null
fi

# ---------- функция ----------
if ! yc serverless function get --name "$FN_NAME" >/dev/null 2>&1; then
  echo "Создаю функцию $FN_NAME"
  yc serverless function create --name "$FN_NAME" >/dev/null
  yc serverless function allow-unauthenticated-invoke "$FN_NAME" >/dev/null
fi
FN_ID="$(yc serverless function get --name "$FN_NAME" --format json | jq -r .id)"
API_URL="https://functions.yandexcloud.net/$FN_ID"

rm -rf build && mkdir -p build
(cd function && zip -q ../build/function.zip index.js handler.js s3storage.js package.json package-lock.json)
echo "Публикую версию функции"
yc serverless function version create \
  --function-name "$FN_NAME" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 30s \
  --source-path build/function.zip \
  --service-account-id "$SA_ID" \
  --environment "SITES_BUCKET=$SITES_BUCKET,UI_ORIGIN=$UI_URL" \
  --secret "environment-variable=ACCESS_KEY_ID,id=$SECRET_ID,key=ACCESS_KEY_ID" \
  --secret "environment-variable=SECRET_ACCESS_KEY,id=$SECRET_ID,key=SECRET_ACCESS_KEY" \
  --secret "environment-variable=UPLOAD_PASSWORD,id=$SECRET_ID,key=UPLOAD_PASSWORD" >/dev/null

# ---------- интерфейс ----------
put() { # put <бакет> <ключ> <файл> <content-type>
  curl -fsS --aws-sigv4 "aws:amz:ru-central1:s3" --user "$AK:$SK" \
    -H "Content-Type: $4" -H "Cache-Control: no-cache" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
    -T "$3" "https://storage.yandexcloud.net/$1/$2" >/dev/null
}
cat > build/config.js <<EOF
window.ARCHIVE_CONFIG = { apiUrl: '$API_URL', sitesUrl: '$SITES_URL' };
EOF
cat > build/redirect.html <<EOF
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=$UI_URL/"><a href="$UI_URL/">Архив сайтов</a>
EOF
echo "Загружаю интерфейс"
put "$UI_BUCKET" index.html public/index.html "text/html; charset=utf-8"
put "$UI_BUCKET" app.css    public/app.css    "text/css; charset=utf-8"
put "$UI_BUCKET" app.js     public/app.js     "text/javascript; charset=utf-8"
put "$UI_BUCKET" unzip.js   public/unzip.js   "text/javascript; charset=utf-8"
put "$UI_BUCKET" config.js  build/config.js   "text/javascript; charset=utf-8"
put "$SITES_BUCKET" index.html build/redirect.html "text/html; charset=utf-8"

echo
echo "Готово!"
echo "  Архив:            $UI_URL"
echo "  Пароль загрузки:  $PASS   (хранится в $STATE)"
