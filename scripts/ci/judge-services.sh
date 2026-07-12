#!/usr/bin/env bash
# judge-services.sh — Start/stop AI judge backend services
# Usage:
#   ./scripts/ci/judge-services.sh start [model]   # Start Ollama, optionally pull model
#   ./scripts/ci/judge-services.sh stop            # Stop Ollama
#   ./scripts/ci/judge-services.sh status          # Check service status
#   ./scripts/ci/judge-services.sh warm [model]    # Warm up model (keep in memory)

set -euo pipefail

# Default model if not specified
DEFAULT_MODEL="${JUDGE_MODEL:-local/qwen3.5:9b}"
OLLAMA_HOST="${JUDGE_OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
OLLAMA_HOST="${OLLAMA_HOST%/v1}"  # Strip /v1 suffix if present

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if Ollama is installed
check_ollama_installed() {
  if ! command -v ollama &> /dev/null; then
    log_error "Ollama is not installed. Install from https://ollama.ai"
    exit 1
  fi
}

# Check if Ollama server is running
is_ollama_running() {
  curl -s "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1
}

# Wait for Ollama to be ready
wait_for_ollama() {
  local max_attempts=30
  local attempt=0
  
  log_info "Waiting for Ollama to be ready..."
  while ! is_ollama_running; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
      log_error "Ollama failed to start after ${max_attempts} seconds"
      exit 1
    fi
    sleep 1
  done
  log_info "Ollama is ready!"
}

# Start Ollama server
start_ollama() {
  local model="${1:-$DEFAULT_MODEL}"
  
  check_ollama_installed
  
  if is_ollama_running; then
    log_info "Ollama is already running"
  else
    log_info "Starting Ollama server..."
    # Keep only one model resident and process one request at a time, so parallel judge workers
    # can't make Ollama load several large models at once (memory thrash). The framework's model
    # gate enforces the same invariant client-side; these make the server cooperate too.
    export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"
    export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
    ollama serve > /dev/null 2>&1 &
    wait_for_ollama
  fi
  
  # Pull model if specified and uses local/ prefix
  if [[ "$model" == local/* ]]; then
    local model_name="${model#local/}"
    log_info "Ensuring model '${model_name}' is available..."
    if ! ollama list | grep -q "$model_name"; then
      log_info "Pulling model '${model_name}'..."
      ollama pull "$model_name"
    else
      log_info "Model '${model_name}' is already available"
    fi
  fi
}

# Stop Ollama server
stop_ollama() {
  if pgrep -x "ollama" > /dev/null; then
    log_info "Stopping Ollama server..."
    pkill -x "ollama" || true
    sleep 2
    log_info "Ollama stopped"
  else
    log_info "Ollama is not running"
  fi
}

# Warm up model (load into memory)
warm_model() {
  local model="${1:-$DEFAULT_MODEL}"
  
  if [[ "$model" != local/* ]]; then
    log_warn "Model warming only applies to local/* models"
    return 0
  fi
  
  local model_name="${model#local/}"
  
  if ! is_ollama_running; then
    log_error "Ollama is not running. Start it first with: $0 start"
    exit 1
  fi
  
  log_info "Warming up model '${model_name}'..."
  
  # Send a minimal request to load the model into memory
  curl -s "${OLLAMA_HOST}/api/chat" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"${model_name}\",
      \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}],
      \"stream\": false,
      \"think\": false,
      \"keep_alive\": \"30m\",
      \"options\": {\"num_predict\": 1}
    }" > /dev/null
  
  log_info "Model '${model_name}' is warmed up and ready"
}

# Check status
check_status() {
  echo "=== AI Judge Services Status ==="
  
  # Ollama status
  if is_ollama_running; then
    echo -e "Ollama: ${GREEN}Running${NC} (${OLLAMA_HOST})"
    
    # List available models
    echo "Available models:"
    ollama list 2>/dev/null | tail -n +2 | awk '{print "  - " $1}'
  else
    echo -e "Ollama: ${RED}Not running${NC}"
  fi
  
  # 9Router status (if configured)
  if [ -n "${JUDGE_GATEWAY_BASE_URL:-}" ]; then
    if curl -s "${JUDGE_GATEWAY_BASE_URL}/models" > /dev/null 2>&1; then
      echo -e "9Router: ${GREEN}Running${NC} (${JUDGE_GATEWAY_BASE_URL})"
    else
      echo -e "9Router: ${YELLOW}Not reachable${NC} (${JUDGE_GATEWAY_BASE_URL})"
    fi
  else
    echo -e "9Router: ${YELLOW}Not configured${NC}"
  fi
}

# Main command dispatch
case "${1:-}" in
  start)
    start_ollama "${2:-}"
    ;;
  stop)
    stop_ollama
    ;;
  status)
    check_status
    ;;
  warm)
    warm_model "${2:-}"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|warm} [model]"
    echo ""
    echo "Commands:"
    echo "  start [model]  - Start Ollama and optionally pull model"
    echo "  stop           - Stop Ollama server"
    echo "  status         - Check service status"
    echo "  warm [model]   - Warm up model (load into memory)"
    echo ""
    echo "Examples:"
    echo "  $0 start                      # Start Ollama with default model"
    echo "  $0 start local/qwen3.5:9b     # Start and ensure specific model"
    echo "  $0 warm                       # Warm up default model"
    echo "  $0 status                     # Check all services"
    exit 1
    ;;
esac
