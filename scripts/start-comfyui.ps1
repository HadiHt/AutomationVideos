$comfyRoot = "C:\Users\hadih\AI\ComfyUI"
$python = Join-Path $comfyRoot "venv312\Scripts\python.exe"

if (!(Test-Path $python)) {
  throw "ComfyUI Python runtime was not found at $python"
}

Set-Location $comfyRoot
& $python ".\main.py" --listen 127.0.0.1 --port 8188
