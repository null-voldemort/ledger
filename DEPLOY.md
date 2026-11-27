# Deployment checklist

## 1. Server clock (do before first start)
Audit entries and month locks use the server time. Timezone Asia/Dhaka.

Linux:
    timedatectl set-timezone Asia/Dhaka
    timedatectl set-ntp true
    timedatectl status        # "System clock synchronized: yes"

Windows (admin PowerShell):
    tzutil /s "Bangladesh Standard Time"
    w32tm /config /syncfromflags:manual /manualpeerlist:"pool.ntp.org" /update
    net stop w32time; net start w32time
    w32tm /query /status

If the VPN blocks outbound NTP, point it at the office's internal time source.

## 2. Reverse proxy
Set PACE_TRUST_PROXY so each user's real IP is used for login lockout and the security log.
    PACE_TRUST_PROXY=1            # one proxy in front (nginx/Caddy)
    PACE_TRUSTED_HOSTS=ledger.example.office
The proxy must send X-Forwarded-For, X-Forwarded-Host and X-Forwarded-Proto.
Without a proxy, leave PACE_TRUST_PROXY unset.

## 3. Accounts
- Admin: edits, voids, restores, verifies, locks periods.
- Staff accounts (one per person): add entries, view, export.
Create staff accounts from the admin panel. Do not share logins.

## 4. Dry run on a staging copy (keep the old process running)
    cp -r ledger ledger-staging && cd ledger-staging
    export PACE_DATA_DIR=$PWD/data-staging PORT=4001
    npm ci && npm run build
    npx tsx scripts/migrate-excel.ts <path-to-real-workbook.xlsx>
    npm start
Check against the workbook: total income, total expense, per-month totals, loan and rent balances,
and the Monthly Sheet reconciliation. Run Verify chain in the admin panel.
When the numbers match, back up the staging data, stop the old process, start the new one on the
real port, and keep the old data folder untouched for at least a week.

## 5. Backups
Copy PACE_DATA_DIR (database + receipts) nightly to a second machine.
