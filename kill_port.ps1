$conn = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $p = $conn.OwningProcess
    Stop-Process -Id $p -Force
    Write-Host "Killed PID $p"
} else {
    Write-Host "No process found on port 5000"
}
