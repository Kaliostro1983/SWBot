# ============================================================
#  SWBot Server Monitor
#  Запускати на моніторинговому ПК (потрібен Tailscale).
#  Автоматично встановлювати через install_monitor.bat
# ============================================================

$SERVER_IP   = "100.120.93.120"
$SERVER_NAME = "ocheret-63 (SWBot)"
$CHECK_EVERY = 30     # секунди між перевірками
$FAIL_ALERT  = 2      # скільки підряд провалів до alert-у
$LOG_FILE    = "$PSScriptRoot\monitor.log"
$MAX_LOG_KB  = 512    # ротація лог-файлу (КБ)

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    try {
        if ((Get-Item $LOG_FILE -ErrorAction SilentlyContinue).Length -gt ($MAX_LOG_KB * 1024)) {
            $old = "$LOG_FILE.old"
            Move-Item $LOG_FILE $old -Force
        }
        Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
    } catch {}
    Write-Host $line
}

function Show-Toast($Title, $Body) {
    try {
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        $esc   = { param($s) [System.Security.SecurityElement]::Escape($s) }
        $xmlStr = "<toast duration='long'><visual><binding template='ToastGeneric'>" +
                  "<text>$(& $esc $Title)</text><text>$(& $esc $Body)</text>" +
                  "</binding></visual></toast>"
        $xDoc = [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]::new()
        $xDoc.LoadXml($xmlStr)
        $notifier = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::CreateToastNotifier($appId)
        $notifier.Show([Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]::new($xDoc))
    } catch {
        Write-Log "Toast error: $_"
    }
}

# ── Main loop ────────────────────────────────────────────────
$failCount = 0
$wasDown   = $false

Write-Log "=== Monitor started: $SERVER_NAME ($SERVER_IP) every ${CHECK_EVERY}s, alert after $FAIL_ALERT fails ==="

while ($true) {
    $ok = Test-Connection -ComputerName $SERVER_IP -Count 1 -Quiet -ErrorAction SilentlyContinue

    if (-not $ok) {
        $failCount++
        Write-Log "FAIL #${failCount} — сервер не відповідає на ping"

        if ($failCount -ge $FAIL_ALERT -and -not $wasDown) {
            $wasDown = $true
            [System.Media.SystemSounds]::Exclamation.Play()
            Show-Toast "Сервер недоступний" "$SERVER_NAME ($SERVER_IP)`nПеревір стан та перезавантаж якщо потрібно."
            Write-Log "ALERT: сповіщення надіслано"
        }
    } else {
        if ($wasDown) {
            $wasDown   = $false
            $failCount = 0
            Show-Toast "Сервер відновився" "$SERVER_NAME ($SERVER_IP) знову відповідає на ping."
            Write-Log "RECOVERY: сервер доступний"
        } else {
            $failCount = 0
        }
    }

    Start-Sleep -Seconds $CHECK_EVERY
}
