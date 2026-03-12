# Find the most recently started venv python process that is hanging on torch._C
# and inspect what it's waiting on

$venvPythons = Get-Process -Name python* -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*contract risk*" } |
    Sort-Object StartTime -Descending

if ($venvPythons.Count -eq 0) {
    Write-Host "No venv python processes found."
    exit
}

$proc = $venvPythons[0]
Write-Host "Inspecting newest process: PID $($proc.Id), started $($proc.StartTime)"
Write-Host "Threads: $($proc.Threads.Count), Handles: $($proc.HandleCount)"

Write-Host "`n--- Thread states ---"
foreach ($t in $proc.Threads) {
    Write-Host "  TID $($t.Id): $($t.ThreadState) / $($t.WaitReason)"
}

# Use handle.exe if available, otherwise check modules
Write-Host "`n--- Loaded modules (DLLs) ---"
try {
    $proc.Modules | Select-Object ModuleName, FileName | Format-Table -AutoSize
} catch {
    Write-Host "Cannot enumerate modules: $_"
}
