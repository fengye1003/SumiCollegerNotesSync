# remote-host.ps1 -- run commands on the Chromebook (Crostini Debian) over SSH
# Maintained by Hoshino Sumi (Xingcheng), created 2026-09-21
#
# Usage (run from the vault root; the ssh-tools dir lives under <workdir>):
#   & <workdir>\ssh-tools\remote-host.ps1 -Command "uname -a"
#   & <workdir>\ssh-tools\remote-host.ps1 -ScriptFile <path-to-.sh>
#   & <workdir>\ssh-tools\remote-host.ps1 -Interactive
#   & <workdir>\ssh-tools\remote-host.ps1 -Check
#
# Target: 任意可通过 SSH 抵达的主机（示例：tailnet 设备）port <PORT>, user <USER>,
#         ed25519 key ~/.ssh/remote-host_ed25519 (passwordless).
#
# IMPORTANT ENVIRONMENT NOTES (this shell is Windows PowerShell 5.1, NOT pwsh 7):
#   1) PS 5.1 parses .ps1 files as ANSI/GBK unless they carry a UTF-8 BOM.
#      => THIS FILE IS DELIBERATELY PURE ASCII. Do not add non-ASCII comments.
#   2) PS 5.1 ProcessStartInfo has no .ArgumentList (that is .NET Core only).
#      => Pass one quoted command line via .Arguments (see ConvertTo-WinArgs).
#   3) PS 5.1 $OutputEncoding defaults to ASCII and $OutputEncoding=UTF8 (with BOM)
#      injects a BOM into piped stdin => remote "#!/usr/bin/env: No such file".
#      => Always use UTF8Encoding($false); script text is sent as raw bytes.
#   4) PowerShell native pipes terminate with CRLF => remote "$'\r': command not found".
#      => Never pipe script text into ssh; write to StandardInput.BaseStream instead.
#   5) Even with raw bytes on StandardInput.BaseStream, .NET Framework (PS 5.1)
#      still writes its stdin encoding PREAMBLE first => every payload arrives
#      with a leading UTF-8 BOM (EF BB BF), which kills line 1 (no shebang, no
#      comment). Proven with a cmd.exe/more control run 2026-09-24.
#      => -ScriptFile feeds bash through: sed -e '1s/^\xEF\xBB\xBF//' | bash

[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
    [Parameter(ParameterSetName = 'Command', Position = 0)]
    [string]$Command = 'echo ok; hostname',

    [Parameter(ParameterSetName = 'ScriptFile', Mandatory = $true)]
    [string]$ScriptFile,

    [Parameter(ParameterSetName = 'Interactive', Mandatory = $true)]
    [switch]$Interactive,

    [Parameter(ParameterSetName = 'Check', Mandatory = $true)]
    [switch]$Check,

    [string]$RemoteHost = 'remote-host',
    [int]$Port = 2121,
    [string]$User = 'remoteuser',
    [string]$KeyPath = "$env:USERPROFILE\.ssh\remote-host_ed25519",
    [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
$OutputEncoding = $script:Utf8NoBom

$script:SshExe = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if (-not $script:SshExe) { $script:SshExe = (Get-Command ssh).Source }

function ConvertTo-WinArgs {
    # Port of the MSVCRT / CommandLineToArgvW quoting rules (list2cmdline).
    param([string[]]$ArgList)

    $sb = New-Object System.Text.StringBuilder
    foreach ($arg in $ArgList) {
        if ($null -eq $arg) { continue }
        if ($sb.Length -gt 0) { [void]$sb.Append(' ') }

        if ($arg.Length -gt 0 -and $arg -notmatch '[ \t"]') {
            [void]$sb.Append($arg)
            continue
        }

        [void]$sb.Append('"')
        $slashes = 0
        foreach ($ch in $arg.ToCharArray()) {
            if ($ch -eq '\') {
                $slashes++
                continue
            }
            if ($ch -eq '"') {
                [void]$sb.Append('\' * ($slashes * 2 + 1))
                [void]$sb.Append('"')
                $slashes = 0
                continue
            }
            if ($slashes -gt 0) {
                [void]$sb.Append('\' * $slashes)
                $slashes = 0
            }
            [void]$sb.Append($ch)
        }
        if ($slashes -gt 0) { [void]$sb.Append('\' * ($slashes * 2)) }
        [void]$sb.Append('"')
    }
    return $sb.ToString()
}

function Invoke-RemoteOnce {
    param(
        [Parameter(Mandatory = $true)][string[]]$SshArgs,
        [string]$StdinText,
        [int]$Timeout = 300
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:SshExe
    $psi.Arguments = ConvertTo-WinArgs $SshArgs
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom

    $sendStdin = $PSBoundParameters.ContainsKey('StdinText')
    if ($sendStdin) { $psi.RedirectStandardInput = $true }

    $p = [System.Diagnostics.Process]::Start($psi)

    if ($sendStdin) {
        $bytes = $script:Utf8NoBom.GetBytes($StdinText)
        $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $p.StandardInput.BaseStream.Flush()
        $p.StandardInput.Close()
    }

    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()

    if (-not $p.WaitForExit($Timeout * 1000)) {
        try { $p.Kill() } catch { }
        throw "remote command timed out after $Timeout s"
    }

    New-Object PSObject -Property @{
        Stdout   = $outTask.Result
        Stderr   = $errTask.Result
        ExitCode = $p.ExitCode
    }
}

# Invoke-Remote -- retry wrapper around Invoke-RemoteOnce.
#
# WHY: the remote-host link flaps (2026-09-22/23 we saw two transport failures):
#   1. the ssh process dies while we are writing the script into its stdin
#      -> ".NET IOException: The pipe has been ended";
#   2. ssh cannot connect / the connection drops
#      -> ExitCode 255 with "ssh: connect to host ..." or "Connection timed out".
# Both are TRANSPORT problems, so retrying is safe and usually fixes it.
#
# NOT retried on purpose:
#   * "remote command timed out" (our own throw) -- the remote may have started
#     the work already, and re-running a non-idempotent command is dangerous;
#   * any other non-zero exit code from the remote command itself.
function Invoke-Remote {
    param(
        [Parameter(Mandatory = $true)][string[]]$SshArgs,
        [string]$StdinText,
        [int]$Timeout = 300,
        [int]$Attempts = 3,
        [int]$RetryDelaySec = 4
    )

    $hasStdin = $PSBoundParameters.ContainsKey('StdinText')
    $transport = 'ssh: connect to host|Connection timed out|Connection refused|Connection reset|Operation timed out|kex_exchange_identification|Broken pipe|reset by peer'

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if ($hasStdin) {
                $r = Invoke-RemoteOnce -SshArgs $SshArgs -StdinText $StdinText -Timeout $Timeout
            } else {
                $r = Invoke-RemoteOnce -SshArgs $SshArgs -Timeout $Timeout
            }
        } catch {
            $msg = $_.Exception.Message
            if ($msg -match 'remote command timed out') { throw }
            if ($attempt -ge $Attempts) { throw }
            Write-Warning "ssh transport error (attempt $attempt/$Attempts): $msg -- retrying in ${RetryDelaySec}s"
            Start-Sleep -Seconds $RetryDelaySec
            continue
        }

        if ($r.ExitCode -ne 0 -and $r.Stderr -match $transport) {
            if ($attempt -ge $Attempts) { return $r }
            Write-Warning "ssh transport failure (attempt $attempt/$Attempts): $($r.Stderr.Trim()) -- retrying in ${RetryDelaySec}s"
            Start-Sleep -Seconds $RetryDelaySec
            continue
        }
        return $r
    }
}

function New-SshArgs {
    param([string]$RemoteCommand)
    $a = @(
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', "$Port",
        '-o', 'IdentitiesOnly=yes',
        '-i', $KeyPath,
        "$User@$RemoteHost"
    )
    if ($RemoteCommand) { $a += $RemoteCommand }
    return , $a
}

function Show-RemoteResult {
    param($Result)
    if ($Result.Stdout) { Write-Output $Result.Stdout.TrimEnd("`r", "`n") }
    if ($Result.Stderr) {
        Write-Output ''
        Write-Output '--- stderr ---'
        Write-Output $Result.Stderr.TrimEnd("`r", "`n")
    }
}

if ($Interactive) {
    & $script:SshExe -p $Port -o IdentitiesOnly=yes -i $KeyPath "$User@$RemoteHost"
    exit $LASTEXITCODE
}

if ($Check) {
    $r = Invoke-Remote -SshArgs (New-SshArgs 'echo remote-host-OK; hostname; uptime') -Timeout 40
    Show-RemoteResult $r
    if ($r.ExitCode -eq 0) { Write-Output "[reachable] $User@${RemoteHost}:$Port" }
    else { Write-Output "[unreachable] $User@${RemoteHost}:$Port (exit $($r.ExitCode))" }
    exit $r.ExitCode
}

if ($ScriptFile) {
    if (-not (Test-Path -LiteralPath $ScriptFile)) { throw "script not found: $ScriptFile" }
    $text = [System.IO.File]::ReadAllText($ScriptFile, $script:Utf8NoBom)
    if (-not $text) { throw "script is empty: $ScriptFile" }
    # strip BOM, normalise to LF (remote is Linux; CRLF causes $'\r' errors)
    $text = $text.TrimStart([char]0xFEFF)
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    if (-not $text.EndsWith("`n")) { $text += "`n" }

    # BOM WORKAROUND (found 2026-09-24, tested): whatever we hand to
    # StandardInput.BaseStream, the bytes that reach the remote shell through
    # redirected stdin ALWAYS start with a UTF-8 BOM (EF BB BF). Verified with
    # a plain cmd.exe/more child, so the preamble comes from .NET Framework's
    # stdin StreamWriter (PS 5.1), NOT from ssh. The BOM stops line 1 from
    # being a shebang/comment: bash then reports "line 1: #!/bin/bash: No such
    # file or directory" (noise) or a syntax error (fatal - whole script is
    # skipped). Strip it on the remote side with sed before bash sees it.
    $r = Invoke-Remote -SshArgs (New-SshArgs "sed -e '1s/^\xEF\xBB\xBF//' | bash") -StdinText $text -Timeout $TimeoutSec
    Show-RemoteResult $r
    exit $r.ExitCode
}

$r = Invoke-Remote -SshArgs (New-SshArgs $Command) -Timeout $TimeoutSec
Show-RemoteResult $r
exit $r.ExitCode
