Set-Location "C:\Users\hadih\Repos\AutomationVideos"

$appUrl = "http://127.0.0.1:3455"

try {
    $response = Invoke-WebRequest -Uri "$appUrl/api/state" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
        Write-Host "Automation Videos is already running at $appUrl" -ForegroundColor Green
        exit 0
    }
} catch {
    # The app is not responding; check whether another process owns its port.
}

$listener = Get-NetTCPConnection -LocalPort 3455 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $ownerLabel = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($listener.OwningProcess)" }
    throw "Port 3455 is already in use by $ownerLabel, but Automation Videos is not responding at $appUrl."
}

npm.cmd start
