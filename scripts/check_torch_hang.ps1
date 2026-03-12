# Check the hanging python processes - what are they waiting on?
Write-Host "=== Hanging Python Process Details ==="
$venvPythons = Get-Process -Name python* -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*contract risk*" }

foreach ($proc in $venvPythons) {
    Write-Host "`nPID $($proc.Id) - CPU: $($proc.CPU)"
    Write-Host "  Path: $($proc.Path)"

    # Check threads
    Write-Host "  Threads: $($proc.Threads.Count)"

    # Check handles
    Write-Host "  Handles: $($proc.HandleCount)"
}

Write-Host "`n=== Checking if any other process has torch DLLs loaded ==="
# Check if libiomp5md.dll is already loaded by another process (conflicts)
$torchLib = "D:\coding\contract risk\.venv\Lib\site-packages\torch\lib"
Write-Host "Torch lib path: $torchLib"
Write-Host "DLL count in torch/lib: $((Get-ChildItem $torchLib -Filter *.dll).Count)"
Get-ChildItem $torchLib -Filter *.dll | Select-Object Name, Length | Format-Table -AutoSize

Write-Host "`n=== Environment Variables relevant to torch ==="
[System.Environment]::GetEnvironmentVariables() |
    Where-Object { $_.Key -like "*OMP*" -or $_.Key -like "*MKL*" -or $_.Key -like "*TORCH*" -or $_.Key -like "*CUDA*" -or $_.Key -like "*KMP*" } |
    ForEach-Object { "$($_.Key) = $($_.Value)" }
