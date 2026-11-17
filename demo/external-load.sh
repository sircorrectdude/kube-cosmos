#!/bin/bash
# Externe Last "aus dem Universum": Requests vom Host über den Traefik-Ingress (localhost:80, Host shop.local).
# Aufruf: bash demo/external-load.sh [Sekunden=120] [parallel=4]
DUR=${1:-120}; PAR=${2:-4}; URL=${INGRESS_URL:-http://localhost}
end=$((SECONDS + DUR))
worker() {
  while [ $SECONDS -lt $end ]; do
    curl -s -o /dev/null -H 'Host: shop.local' "$URL/"
    curl -s -o /dev/null -H 'Host: shop.local' "$URL/api/"
    [ $((RANDOM % 8)) -eq 0 ] && curl -s -o /dev/null -H 'Host: shop.local' "$URL/error"
    [ $((RANDOM % 10)) -eq 0 ] && curl -s -o /dev/null -H 'Host: shop.local' "$URL/api/fail"
    sleep 0.2
  done
}
for i in $(seq "$PAR"); do worker & done
wait
echo "externe Last beendet"
