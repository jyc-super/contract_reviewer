Get-Process | Where-Object {
    $_.Name -like '*defend*' -or
    $_.Name -like '*sentinel*' -or
    $_.Name -like '*carbon*' -or
    $_.Name -like '*crowd*' -or
    $_.Name -like '*cylance*' -or
    $_.Name -like '*trend*' -or
    $_.Name -like '*MsMpEng*' -or
    $_.Name -like '*windefend*' -or
    $_.Name -like '*avast*' -or
    $_.Name -like '*avg*' -or
    $_.Name -like '*bitdefender*' -or
    $_.Name -like '*mcafee*' -or
    $_.Name -like '*norton*' -or
    $_.Name -like '*kaspersky*' -or
    $_.Name -like '*eset*' -or
    $_.Name -like '*sophos*' -or
    $_.Name -like '*malware*' -or
    $_.Name -like '*symantec*'
} | Select-Object Name, Id | Format-Table -AutoSize
