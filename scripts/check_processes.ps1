# Check python processes
Write-Host "=== Python Processes ==="
Get-Process -Name python* -ErrorAction SilentlyContinue | Select-Object Name,Id,CPU,Path | Format-Table -AutoSize

# Check all security-related processes
Write-Host "=== Security/AV Processes ==="
$secNames = @('MsMpEng','windefend','avast','avg','bitdefender','mcafee','norton',
              'kaspersky','eset','sophos','symantec','sentinel','crowdstrike',
              'cybereason','carbon','cylance','trend','fireeye','tanium','qualys',
              'sfc','parity','cb','bdagent')
foreach ($name in $secNames) {
    $procs = Get-Process -Name "*$name*" -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Select-Object Name,Id,CPU | Format-Table -AutoSize
    }
}

# Show Windows Defender status
Write-Host "=== Windows Defender Service ==="
Get-Service -Name 'WinDefend','Sense','WdNisSvc' -ErrorAction SilentlyContinue | Select-Object Name,Status | Format-Table -AutoSize

# Check if real-time protection is enabled
Write-Host "=== Defender Real-Time Protection ==="
try {
    $pref = Get-MpPreference -ErrorAction Stop
    Write-Host "DisableRealtimeMonitoring: $($pref.DisableRealtimeMonitoring)"
} catch {
    Write-Host "Cannot query MpPreference: $_"
}
