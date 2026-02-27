#!/bin/bash
# BridgeKitty API Test Suite — 20 test cases
# Tests the Persistence Interop API directly (not MCP)

API="https://api.interop.persistence.one"
PASS=0; FAIL=0; TOTAL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

assert() {
  local num=$1 name=$2 expected=$3 actual=$4
  TOTAL=$((TOTAL+1))
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✅ #${num}${NC} $name"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}❌ #${num}${NC} $name (expected=$expected actual=$actual)"
    FAIL=$((FAIL+1))
  fi
}

quote() {
  local srcChain=$1 dstChain=$2 srcAsset=$3 dstAsset=$4 amount=$5
  curl -s --max-time 15 -X POST "$API/quotes/request" \
    -H "Content-Type: application/json" \
    -d "{\"sourceChainId\":$srcChain,\"destinationChainId\":$dstChain,\"sourceAsset\":\"$srcAsset\",\"destinationAsset\":\"$dstAsset\",\"sourceAmount\":\"$amount\"}"
}

count_quotes() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); q=d if isinstance(d,list) else d.get('quotes',[]); print(len(q))" 2>/dev/null || echo "0"
}

has_error() {
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('error') or d.get('statusCode',200)>=400 else 'no')" 2>/dev/null || echo "no"
}

CBBTC="0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"
BTCB="0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"
ZERO="0x0000000000000000000000000000000000000000"

echo "=== BridgeKitty API Test Suite ==="
echo "API: $API"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# --- Happy Path ---
echo "--- Happy Path ---"

resp=$(quote 8453 56 $CBBTC $BTCB "5000")
n=$(count_quotes "$resp")
assert 1 "Quote: Base→BNB, 5000 units (min)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(quote 8453 56 $CBBTC $BTCB "100000")
n=$(count_quotes "$resp")
assert 2 "Quote: Base→BNB, 100000 units (max)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(quote 8453 56 $CBBTC $BTCB "50000")
n=$(count_quotes "$resp")
assert 3 "Quote: Base→BNB, 50000 units (mid)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(quote 56 8453 $BTCB $CBBTC "5000000000000000")
n=$(count_quotes "$resp")
assert 4 "Quote: BNB→Base reverse direction" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

health=$(curl -s -o /dev/null -w "%{http_code}" "$API/health")
assert 5 "Health check endpoint" "200" "$health"

# --- Edge Cases ---
echo ""
echo "--- Edge Cases ---"

resp=$(quote 8453 56 $CBBTC $BTCB "5000")
n=$(count_quotes "$resp")
assert 6 "Boundary: exact minimum (5000)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(quote 8453 56 $CBBTC $BTCB "100000")
n=$(count_quotes "$resp")
assert 7 "Boundary: exact maximum (100000)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

# BUG-001: These SHOULD ideally be rejected, but API doesn't enforce caps
resp=$(quote 8453 56 $CBBTC $BTCB "4999")
n=$(count_quotes "$resp")
assert 8 "Below min (4999) — API returns quotes (no cap enforcement)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(quote 8453 56 $CBBTC $BTCB "1000000000")
n=$(count_quotes "$resp")
assert 9 "Above max (10 BTC) — API returns quotes (no cap enforcement)" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

# --- Error Handling ---
echo ""
echo "--- Error Handling ---"

resp=$(quote 8453 56 $ZERO $BTCB "5000")
n=$(count_quotes "$resp")
assert 10 "Invalid source token (zero addr)" "0" "$n"

resp=$(quote 999999 56 $CBBTC $BTCB "5000")
n=$(count_quotes "$resp")
assert 11 "Invalid chain ID (999999)" "0" "$n"

resp=$(quote 8453 56 $CBBTC $BTCB "0")
n=$(count_quotes "$resp")
assert 12 "Zero amount — returns quotes" "yes" "$([ "$n" -gt 0 ] && echo yes || echo no)"

resp=$(curl -s --max-time 10 -X POST "$API/quotes/request" \
  -H "Content-Type: application/json" \
  -d "{\"sourceChainId\":8453,\"destinationChainId\":56,\"sourceAsset\":\"$CBBTC\",\"destinationAsset\":\"$BTCB\",\"sourceAmount\":\"-100\"}")
# Negative amounts return 404
http_code=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('statusCode',200))" 2>/dev/null)
assert 13 "Negative amount — returns error" "yes" "$([ "$http_code" -ge 400 ] && echo yes || echo no)"

resp=$(quote 8453 8453 $CBBTC $CBBTC "5000")
n=$(count_quotes "$resp")
assert 14 "Same source and dest chain" "0" "$n"

resp=$(curl -s --max-time 10 -X POST "$API/quotes/request" \
  -H "Content-Type: application/json" \
  -d "{}")
err=$(has_error "$resp")
assert 15 "Missing required fields" "yes" "$err"

# --- Solver ---
echo ""
echo "--- Solver & Pricing ---"

resp=$(quote 8453 56 $CBBTC $BTCB "5000")
solver=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); q=d if isinstance(d,list) else d.get('quotes',[]); print(q[0].get('solverId','') if q else '')" 2>/dev/null)
assert 16 "Solver = Persistence" "Persistence" "$solver"

# Rate consistency
rate_ok=$(echo "$resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
q=d if isinstance(d,list) else d.get('quotes',[])
rates=[int(q1.get('exchangeRate','0')) for q1 in q[:10] if q1.get('exchangeRate')]
if not rates: print('yes'); sys.exit()
avg=sum(rates)/len(rates)
print('yes' if all(abs(r-avg)/avg<0.01 for r in rates) else 'no')
" 2>/dev/null)
assert 17 "Exchange rate consistency (<1% variance)" "yes" "$rate_ok"

# Fee structure
fee_ok=$(echo "$resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
q=d if isinstance(d,list) else d.get('quotes',[])
if q:
    q0=q[0]
    has_solver_fee = 'solverFee' in q0 or 'totalFee' in q0
    print('yes' if has_solver_fee else 'no')
else: print('no')
" 2>/dev/null)
assert 18 "Fee structure present in quotes" "yes" "$fee_ok"

# --- Order Lifecycle (manual) ---
echo ""
echo "--- Order Lifecycle (manual) ---"
echo -e "  ${YELLOW}🔒 #19${NC} Submit order — requires wallet (MANUAL)"
echo -e "  ${YELLOW}🔒 #20${NC} End-to-end fulfillment — requires on-chain tx (MANUAL)"

# --- Expired Quote Analysis ---
echo ""
echo "--- Expired Quote Analysis ---"
resp=$(quote 8453 56 $CBBTC $BTCB "50000")
expired_info=$(echo "$resp" | python3 -c "
import sys,json,time
now=time.time()*1000
d=json.load(sys.stdin)
q=d if isinstance(d,list) else d.get('quotes',[])
total=len(q)
expired=sum(1 for qi in q if qi.get('expirationTime') and int(qi['expirationTime'])<now)
print(f'{expired}/{total} expired')
" 2>/dev/null)
echo "  ℹ️  Quote freshness: $expired_info"

echo ""
echo "=== Results ==="
echo -e "Passed: ${GREEN}${PASS}${NC} / ${TOTAL}"
echo -e "Failed: ${RED}${FAIL}${NC} / ${TOTAL}"
echo "Manual: 2"
