# Launches llama-server with the VLM used by the dashboard agent.
# Pinned for RTX 4050 Laptop GPU, 6GB VRAM. See AGENT_PLAN.md section 5.
# Do not raise context or quant level without re-checking VRAM headroom.

$ErrorActionPreference = "Stop"

$LlamaDir = "E:\llama.cpp"
$ModelPath = "E:\llama.cpp\models\Jackrong_Qwen3.5-4B.Q4_K_M_v2.gguf"
$MmprojPath = "E:\llama.cpp\models\Jackrong_Qwen3.5-4B.Q6_K_v2_mmproj.gguf"

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
