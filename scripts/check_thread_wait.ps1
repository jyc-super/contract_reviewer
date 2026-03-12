# Check what the hanging python threads are waiting on
$venvPythons = Get-Process -Name python* -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*contract risk*" }

foreach ($proc in $venvPythons) {
    Write-Host "`n=== PID $($proc.Id) Thread Wait States ==="
    foreach ($thread in $proc.Threads) {
        Write-Host "  Thread $($thread.Id): State=$($thread.ThreadState) WaitReason=$($thread.WaitReason)"
    }
}
