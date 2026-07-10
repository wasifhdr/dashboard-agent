# Launches the STOCK comparison model (Qwen3.5-4B base, no reasoning LoRA)
# for the Phase 3 model A/B against the Jackrong Claude-Opus-reasoning
# distill. Same base family and same pinned flags as start-llama.ps1 so the
# only real variable is the reasoning fine-tune - a higher-fidelity Q6_K
# quant is used here only because that's what's locally available for this
# pairing (a Q4_K_M stock build would be a tighter apples-to-apples match;
# note this as a caveat when reading benchmark results).
#
# Stop start-llama.ps1 first - only one llama-server can hold the GPU at once.

$ErrorActionPreference = "Stop"

$LlamaDir = "E:\llama.cpp"
$ModelPath = "E:\llama.cpp\models\Qwen3.5-4B-Q6_K.gguf"
$MmprojPath = "E:\llama.cpp\models\qwen3.5-mmproj-F16.gguf"

if (-not (Test-Path $ModelPath)) {
    Write-Error "Model not found at $ModelPath"
    exit 1
}
if (-not (Test-Path $MmprojPath)) {
    Write-Error "mmproj not found at $MmprojPath"
    exit 1
}

& "$LlamaDir\llama-server.exe" `
    --model $ModelPath `
    --mmproj $MmprojPath `
    --ctx-size 8192 `
    --gpu-layers 99 `
    --flash-attn on `
    --cache-type-k q8_0 `
    --cache-type-v q8_0 `
    --host 127.0.0.1 `
    --port 8080
