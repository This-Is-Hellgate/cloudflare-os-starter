[CmdletBinding()]
param(
    [ValidateSet("store", "load", "status", "remove")]
    [string]$Action = "store"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$secretsDirectory = Join-Path $repoRoot ".secrets"
$secretFile = Join-Path $secretsDirectory "cloudflare-access-admin-token.dpapi"
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Set-PrivateAcl {
    param([Parameter(Mandatory)][string]$Path)

    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleAll($rule)
    }

    $inheritance = if ((Get-Item -LiteralPath $Path).PSIsContainer) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }

    $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $currentIdentity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($accessRule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Convert-SecureStringToPlainText {
    param([Parameter(Mandatory)][Security.SecureString]$SecureValue)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

switch ($Action) {
    "store" {
        New-Item -ItemType Directory -Path $secretsDirectory -Force | Out-Null
        Set-PrivateAcl -Path $secretsDirectory

        $secureToken = Read-Host "Paste the Cloudflare Access API token" -AsSecureString
        if ($secureToken.Length -eq 0) {
            throw "No token was entered."
        }

        # With no explicit key, ConvertFrom-SecureString uses Windows DPAPI. The resulting
        # ciphertext can only be decrypted by this Windows account on this computer.
        $encryptedToken = ConvertFrom-SecureString -SecureString $secureToken
        Set-Content -LiteralPath $secretFile -Value $encryptedToken -Encoding ASCII -NoNewline
        Set-PrivateAcl -Path $secretFile

        Remove-Variable secureToken, encryptedToken -ErrorAction SilentlyContinue
        Write-Host "Encrypted token stored at .secrets\cloudflare-access-admin-token.dpapi"
        Write-Host "Load it with: .\scripts\cloudflare-access-token.ps1 load"
    }

    "load" {
        if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
            throw "No stored token exists. Run this script with the 'store' action first."
        }

        $secureToken = Get-Content -LiteralPath $secretFile -Raw | ConvertTo-SecureString
        $env:CF_ACCESS_ADMIN_TOKEN = Convert-SecureStringToPlainText -SecureValue $secureToken
        Remove-Variable secureToken -ErrorAction SilentlyContinue

        Write-Host "CF_ACCESS_ADMIN_TOKEN is loaded for this PowerShell process and its child processes."
        Write-Host "The token value was not printed."
    }

    "status" {
        if (Test-Path -LiteralPath $secretFile -PathType Leaf) {
            Write-Host "An encrypted Cloudflare Access token is stored."
        } else {
            Write-Host "No encrypted Cloudflare Access token is stored."
        }
    }

    "remove" {
        if (Test-Path -LiteralPath $secretFile -PathType Leaf) {
            Remove-Item -LiteralPath $secretFile -Force
            Write-Host "The encrypted token file was removed."
        } else {
            Write-Host "No encrypted token file exists."
        }
        Remove-Item Env:CF_ACCESS_ADMIN_TOKEN -ErrorAction SilentlyContinue
    }
}
