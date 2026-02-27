#!/bin/bash
# BridgeKitty - 20 diverse test cases with timing
# Tests various tokens across different chains

ADDR="0x0000000000000000000000000000000000000001"
RESULTS_FILE="test-results.md"

echo "# BridgeKitty Test Results - $(date '+%Y-%m-%d %H:%M')" > $RESULTS_FILE
echo "" >> $RESULTS_FILE
echo "| # | Route | Amount | Time (s) | Quotes | Best Provider | Best Output | Status |" >> $RESULTS_FILE
echo "|---|-------|--------|----------|--------|---------------|-------------|--------|" >> $RESULTS_FILE

run_test() {
  local num=$1 from_chain=$2 from_token=$3 to_chain=$4 to_token=$5 amount=$6
  local label="${amount} ${from_token} ${from_chain} → ${to_token} ${to_chain}"
  
  echo "[$num/20] Testing: $label"
  
  local start=$(python3 -c "import time; print(time.time())")
  local result=$(echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"bridge_get_quote\",\"arguments\":{\"fromChain\":\"${from_chain}\",\"fromToken\":\"${from_token}\",\"toChain\":\"${to_chain}\",\"toToken\":\"${to_token}\",\"amount\":\"${amount}\",\"fromAddress\":\"${ADDR}\"}}}" | node dist/index.js 2>/dev/null)
  local end=$(python3 -c "import time; print(time.time())")
  local elapsed=$(python3 -c "print(f'{$end - $start:.2f}')")
  
  local total_routes=$(echo "$result" | grep -o '"totalRoutesFound":[0-9]*' | grep -o '[0-9]*')
  local best_provider=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'])" 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('bestQuote',{}).get('provider','N/A'))" 2>/dev/null || echo "N/A")
  local best_output=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'])" 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('bestQuote',{}).get('outputAmount','N/A'))" 2>/dev/null || echo "N/A")
  
  local status="✅"
  if [ -z "$total_routes" ] || [ "$total_routes" = "0" ]; then
    status="❌ no routes"
    total_routes="0"
  fi
  
  echo "  → ${elapsed}s, ${total_routes} routes, best: ${best_provider}"
  echo "| $num | $label | $amount | $elapsed | $total_routes | $best_provider | $best_output | $status |" >> $RESULTS_FILE
}

cd ~/projects/bridgekitty

# Same-token bridging (should include Across)
run_test 1  arbitrum USDC ethereum USDC 100
run_test 2  base     USDC arbitrum USDC 500
run_test 3  ethereum ETH  arbitrum ETH  0.1
run_test 4  optimism USDC base     USDC 250

# Cross-token swaps (Across should NOT appear)
run_test 5  arbitrum USDC ethereum ETH  100
run_test 6  ethereum ETH  base     USDC 0.05
run_test 7  base     ETH  arbitrum USDC 0.1
run_test 8  arbitrum ETH  optimism USDC 0.5

# Exotic routes / less common chains
run_test 9  polygon  USDC ethereum ETH  200
run_test 10 ethereum USDC polygon  USDC 1000
run_test 11 avalanche USDC ethereum USDC 500
run_test 12 bsc      BNB  ethereum ETH  1

# Popular DeFi tokens
run_test 13 ethereum WBTC arbitrum WBTC 0.01
run_test 14 arbitrum ETH  base     ETH  1
run_test 15 ethereum USDT arbitrum USDT 500

# Cross-token with DeFi tokens
run_test 16 ethereum USDC arbitrum ETH  1000
run_test 17 base     ETH  ethereum USDC 0.5
run_test 18 arbitrum USDC base     ETH  200

# Large amounts
run_test 19 ethereum USDC arbitrum USDC 10000
run_test 20 arbitrum ETH  ethereum ETH  5

echo "" >> $RESULTS_FILE
echo "## Summary" >> $RESULTS_FILE
echo "" >> $RESULTS_FILE

cat $RESULTS_FILE
