<#
  Checks (and with -Fix, repairs) the Exchange "RBAC for Applications" setup that gives MailVault
  read-only mail access to the monitored mailboxes. Run it in an admin PowerShell window after
  signing in with:  Connect-ExchangeOnline -UserPrincipalName admin@finwave.co

  .\check-exchange-rbac.ps1 -Mailbox aif@finwave.co          # report only, changes nothing
  .\check-exchange-rbac.ps1 -Mailbox aif@finwave.co -Fix     # also repairs what is wrong
#>
param(
  [Parameter(Mandatory = $true)][string]$Mailbox,
  [string]$AppId = '1a5bf79e-78a4-4192-b0aa-13b2b010a0b8',
  # Object ID of the ENTERPRISE APPLICATION (service principal), not of the app registration.
  [string]$ObjectId = '688d2572-7c12-4970-b83a-badc79c04697',
  [string]$Group = 'mailvault-monitored@finwave.co',
  [string]$ScopeName = 'MailVault Mailboxes',
  [string]$Role = 'Application Mail.Read',
  [switch]$Fix
)

$ErrorActionPreference = 'Stop'
$problems = 0
function Ok($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:problems++ }
function Info($m) { Write-Host "       $m" -ForegroundColor Gray }

if (-not (Get-Command Get-ServicePrincipal -ErrorAction SilentlyContinue)) {
  throw 'Not connected to Exchange Online. Run: Connect-ExchangeOnline -UserPrincipalName <admin>'
}

Write-Host "`n0. Tenant" -ForegroundColor Cyan
$mbx = Get-Recipient -Identity $Mailbox -ErrorAction SilentlyContinue
if (-not $mbx) { throw "Mailbox $Mailbox not found. Are you signed in to the right Microsoft 365 tenant?" }
Ok "Signed in to the tenant that holds $Mailbox ($($mbx.RecipientTypeDetails))"

Write-Host "`n1. Service principal in Exchange" -ForegroundColor Cyan
$sp = Get-ServicePrincipal | Where-Object { $_.AppId -eq $AppId }
if (-not $sp) {
  Bad "No Exchange service principal with AppId $AppId"
  if ($Fix) {
    $sp = New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName 'MailVault'
    Info 'Created it.'
  }
} elseif ($sp.ObjectId -ne $ObjectId) {
  Bad "Service principal has ObjectId $($sp.ObjectId), expected $ObjectId (the enterprise app's Object ID)"
  if ($Fix) {
    Get-ManagementRoleAssignment -RoleAssignee $sp.Identity -ErrorAction SilentlyContinue | Remove-ManagementRoleAssignment -Confirm:$false
    Remove-ServicePrincipal -Identity $sp.Identity -Confirm:$false
    $sp = New-ServicePrincipal -AppId $AppId -ObjectId $ObjectId -DisplayName 'MailVault'
    Info 'Re-created it with the correct Object ID (old role assignments removed; step 4 adds the right one).'
  }
} else {
  Ok "AppId $AppId, ObjectId $($sp.ObjectId), name '$($sp.DisplayName)'"
}

Write-Host "`n2. Mailbox group" -ForegroundColor Cyan
$grp = Get-Recipient -Identity $Group -ErrorAction SilentlyContinue
if (-not $grp) {
  Bad "Group $Group not found"
  if ($Fix) {
    New-DistributionGroup -Name 'MailVault-Monitored' -PrimarySmtpAddress $Group -Type Security -Members $Mailbox | Out-Null
    for ($i = 0; $i -lt 12 -and -not $grp; $i++) { Start-Sleep -Seconds 5; $grp = Get-Recipient -Identity $Group -ErrorAction SilentlyContinue }
    if (-not $grp) { throw 'Group created but not visible yet. Wait a minute and run the script again with -Fix.' }
    Info "Created mail-enabled security group $Group with $Mailbox as member."
    Info "DN: $($grp.DistinguishedName)"
  }
} else {
  Ok "$($grp.DisplayName) ($($grp.RecipientTypeDetails))"
  Info "DN: $($grp.DistinguishedName)"
  if ($grp.RecipientTypeDetails -eq 'GroupMailbox') {
    $members = Get-UnifiedGroupLinks -Identity $Group -LinkType Members -ResultSize Unlimited
  } else {
    $members = Get-DistributionGroupMember -Identity $Group -ResultSize Unlimited
  }
  if ($members | Where-Object { $_.Guid -eq $mbx.Guid }) {
    Ok "$Mailbox is a direct member (nested groups do not count)"
  } else {
    Bad "$Mailbox is NOT a direct member of the group"
    if ($Fix) {
      if ($grp.RecipientTypeDetails -eq 'GroupMailbox') { Add-UnifiedGroupLinks -Identity $Group -LinkType Members -Links $Mailbox }
      else { Add-DistributionGroupMember -Identity $Group -Member $Mailbox -BypassSecurityGroupManagerCheck }
      Info 'Added it.'
    }
  }
}

Write-Host "`n3. Management scope" -ForegroundColor Cyan
$expected = if ($grp) { "MemberOfGroup -eq '$($grp.DistinguishedName)'" } else { $null }
$scope = Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue
if (-not $scope) {
  Bad "Scope '$ScopeName' not found"
  if ($Fix -and $expected) { $scope = New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter $expected; Info 'Created it.' }
} else {
  Info "Filter: $($scope.RecipientFilter)"
  if ($grp -and $scope.RecipientFilter -like "*$($grp.DistinguishedName)*") {
    Ok 'Filter points at the group'
  } else {
    Bad 'Filter does not contain the group DN (usually created while $groupDN was empty)'
    if ($Fix -and $expected) { Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $expected; Info "Set to: $expected" }
  }
}

Write-Host "`n4. Role assignment" -ForegroundColor Cyan
$assign = Get-ManagementRoleAssignment -Role $Role -ErrorAction SilentlyContinue |
  Where-Object { $sp -and ($_.RoleAssignee -eq $sp.Identity -or $_.RoleAssigneeName -eq $sp.Identity -or $_.RoleAssigneeName -eq $sp.Name -or $_.RoleAssigneeName -eq $AppId -or $_.RoleAssigneeName -eq $ObjectId) }
if (-not $assign) {
  Bad "No '$Role' assignment for the MailVault service principal"
  Get-ManagementRoleAssignment -Role $Role -ErrorAction SilentlyContinue | ForEach-Object { Info "existing: $($_.Name) -> $($_.RoleAssigneeName), scope $($_.CustomResourceScope)" }
  if ($Fix -and $sp) {
    New-ManagementRoleAssignment -App $AppId -Role $Role -CustomResourceScope $ScopeName | Out-Null
    Info 'Created it.'
  }
} else {
  foreach ($a in $assign) {
    if ($a.CustomResourceScope -eq $ScopeName) { Ok "$($a.Name), scope '$($a.CustomResourceScope)', enabled $($a.Enabled)" }
    else { Bad "$($a.Name) uses scope '$($a.CustomResourceScope)' instead of '$ScopeName'" }
  }
}

Write-Host "`n5. Exchange's own verdict for $Mailbox (ignores the cache)" -ForegroundColor Cyan
Test-ServicePrincipalAuthorization -Identity $AppId -Resource $Mailbox |
  Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope -AutoSize

if ($problems -eq 0) {
  Write-Host 'Setup looks correct. If InScope is True above, Graph may still serve a cached answer for up to 2 hours.' -ForegroundColor Green
} elseif ($Fix) {
  Write-Host "Fixed $problems problem(s). Wait 30-60 minutes, then use Test connection in MailVault." -ForegroundColor Yellow
} else {
  Write-Host "$problems problem(s) found. Re-run with -Fix to repair them." -ForegroundColor Yellow
}
