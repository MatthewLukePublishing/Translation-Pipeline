function Wait-InDesignUiIdle {
    # Never queue COM polling behind export/link/background work. First wait
    # for the Windows UI thread to be responsive and quiescent for three samples.
    # Worker CPU can remain active even when all InDesign background tasks are
    # finished; whole-process CPU is not a reliable UI-idle test.
    $stable = 0
    $initialProcess = Get-Process -Name InDesign -ErrorAction Stop
    $uiThread = $initialProcess.Threads | Sort-Object StartTime | Select-Object -First 1
    $uiThreadId = $uiThread.Id
    $lastCpu = $uiThread.TotalProcessorTime.TotalSeconds
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        Start-Sleep -Seconds 2
        $process = Get-Process -Name InDesign -ErrorAction Stop
        $uiThread = $process.Threads | Where-Object Id -eq $uiThreadId
        if (-not $uiThread) { throw 'InDesign UI thread changed; stop and inspect before continuing.' }
        $currentCpu = $uiThread.TotalProcessorTime.TotalSeconds
        if ($process.Responding -and $uiThread.ThreadState -eq 'Wait' -and ($currentCpu - $lastCpu) -lt 0.1) { $stable++ } else { $stable = 0 }
        $lastCpu = $currentCpu
        if ($stable -ge 3) { return }
        if ($attempt % 15 -eq 14) { Write-Output 'SOURCE_WAIT|waiting for InDesign background work; no COM polling' }
    }
    throw 'InDesign did not become idle; no more Adobe calls were issued.'
}
