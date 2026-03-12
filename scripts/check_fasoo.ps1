Write-Host "=== Fasoo DRM Processes ==="
Get-Process | Where-Object { $_.Name -like '*fasoo*' -or $_.Name -like '*f_agent*' -or $_.Name -like '*fdrm*' -or $_.Name -like '*fmws*' -or $_.Name -like '*f_mws*' -or $_.Name -like '*frm*' } | Select-Object Name, Id, CPU, Path | Format-Table -AutoSize

Write-Host "`n=== Fasoo Services ==="
Get-Service | Where-Object { $_.Name -like '*fasoo*' -or $_.Name -like '*fdrm*' -or $_.DisplayName -like '*Fasoo*' -or $_.DisplayName -like '*DRM*' } | Select-Object Name, DisplayName, Status | Format-Table -AutoSize

Write-Host "`n=== Fasoo DRM Install Location ==="
if (Test-Path "C:\Program Files\Fasoo DRM") {
    Get-ChildItem "C:\Program Files\Fasoo DRM" | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
} else {
    Write-Host "C:\Program Files\Fasoo DRM not found"
}

Write-Host "`n=== AppInit_DLLs Registry (global DLL injection) ==="
$appInit = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows' -Name AppInit_DLLs -ErrorAction SilentlyContinue
if ($appInit) { Write-Host "AppInit_DLLs: $($appInit.AppInit_DLLs)" }
$appInit64 = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows NT\CurrentVersion\Windows' -Name AppInit_DLLs -ErrorAction SilentlyContinue
if ($appInit64) { Write-Host "AppInit_DLLs (Wow64): $($appInit64.AppInit_DLLs)" }

Write-Host "`n=== Image File Execution Options (IFEO) for python ==="
$ifeo = Get-Item 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\python.exe' -ErrorAction SilentlyContinue
if ($ifeo) { $ifeo | Get-ItemProperty } else { Write-Host "No IFEO entry for python.exe" }
