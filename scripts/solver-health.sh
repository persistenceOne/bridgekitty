#!/bin/bash
# BridgeKitty Solver Health Check
# Checks: API liveness, quote freshness, response times, expired quote ratio

API="https://api.interop.persistence.one"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo "=== BridgeKitty Solver Health Check ==="
echo "Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# 1. Health endpoint
echo -n "1. API Health: "
start=$(python3 -c "import time; print(int(time.time()*1000))")
health=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$API/health")
end=$(python3 -c "import time; print(int(time.time()*1000))")
latency=$((end - start))
if [ "$health" = "200" ]; then
  echo -e "${GREEN}OK${NC} (${latency}ms)"
else
  echo -e "${RED}FAIL${NC} (HTTP $health, ${latency}ms)"
fi

# 2. Quote request (Base CBBTC → BNB BTCB, min amount)
echo -n "2. Quote Request (5000 units): "
start=$(python3 -c "import time; print(int(time.time()*1000))")
quote_resp=$(curl -s --max-time 15 -X POST "$API/quotes/request" \
  -H "Content-Type: application/json" \
  -d '{"sourceChainId":8453,"destinationChainId":56,"sourceAsset":"0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf","destinationAsset":"0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c","sourceAmount":"5000"}')
end=$(python3 -c "import time; print(int(time.time()*1000))")
latency=$((end - start))

total_quotes=$(echo "$quote_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); q=d if isinstance(d,list) else d.get('quotes',[]); print(len(q))" 2>/dev/null || echo "0")
echo -e "${GREEN}${total_quotes} quotes${NC} (${latency}ms)"

# 3. Expired quote analysis
echo -n "3. Expired Quotes: "
now_ms=$(python3 -c "import time; print(int(time.time()*1000))")
expired=$(echo "$quote_resp" | python3 -c "
import sys, json, time
now = time.time() * 1000
d = json.load(sys.stdin)
quotes = d if isinstance(d, list) else d.get('quotes', [])
expired = sum(1 for q in quotes if q.get('expirationTime') and int(q['expirationTime']) < now)
print(f'{expired}/{len(quotes)}')
" 2>/dev/null || echo "?/?")
if echo "$expired" | grep -q "^0/"; then
  echo -e "${GREEN}${expired} expired${NC}"
else
  echo -e "${YELLOW}${expired} expired${NC}"
fi

# 4. Reverse direction check
echo -n "4. Reverse Direction (BNB→Base): "
start=$(python3 -c "import time; print(int(time.time()*1000))")
rev_resp=$(curl -s --max-time 15 -X POST "$API/quotes/request" \
  -H "Content-Type: application/json" \
  -d '{"sourceChainId":56,"destinationChainId":8453,"sourceAsset":"0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c","destinationAsset":"0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf","sourceAmount":"5000000000000000"}')
end=$(python3 -c "import time; print(int(time.time()*1000))")
latency=$((end - start))
rev_count=$(echo "$rev_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); q=d if isinstance(d,list) else d.get('quotes',[]); print(len(q))" 2>/dev/null || echo "0")
if [ "$rev_count" -gt 0 ] 2>/dev/null; then
  echo -e "${GREEN}${rev_count} quotes${NC} (${latency}ms)"
else
  echo -e "${RED}No quotes${NC} (${latency}ms)"
fi

# 5. Summary
echo ""
echo "=== Summary ==="
echo "API: $([ "$health" = "200" ] && echo "UP" || echo "DOWN")"
echo "Solver: $([ "$total_quotes" -gt 0 ] && echo "ACTIVE ($total_quotes quotes)" || echo "INACTIVE")"
echo "Expired ratio: $expired"
echo "Quote latency: check above"
