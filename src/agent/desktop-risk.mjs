// Risk of a shell command or desktop click, decided by Friday (never by the model).
// The owner wants full access to his laptop WITHOUT being asked for routine work (open apps, read the screen, type,
// click, run commands, read/write files). Approval stays only for what is irreversible or reaches other people/money:
//   deletion   permanent deletes (rm, find -delete, git clean/reset --hard, docker rm), uninstalling software
//   system     sudo/pkexec, services, firewall/network/users/passwords, security settings, reading credentials
//   messaging  anything that sends data to other people/services: mail, git push, curl POST, publish, scp/rsync out
//   spending   purchases (labels like "Buy now"; shells don't buy things)
// Heuristics on purpose: a false "ask" costs one tap, a missed one is the failure to avoid, so patterns are broad.

const DELETE_SH = [
  /(^|[;&|(\s])(sudo\s+)?(rm|rmdir|unlink|shred|srm|wipe)\s/i,
  /\bfind\b[^;&|]*\s-(delete|exec\s+rm)\b/i,
  /\bgit\s+(clean\s+-\w*f|reset\s+--hard|checkout\s+--\s|restore\s|branch\s+-D|stash\s+(drop|clear)|push\s+[^;&|]*(--force|-f\b|--delete|:))/i,
  /\b(apt|apt-get|aptitude|dpkg|snap|flatpak|pip3?|pipx|npm|pnpm|yarn|cargo|brew|gem|conda)\s+(-\S+\s+)*(remove|purge|uninstall|autoremove|rm)\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|image\s+prune|container\s+prune)\b/i,
  /\b(dropdb|dropuser)\b|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bdelete\s+from\b/i,
  /\bgio\s+trash\s+--empty\b|\btrash-empty\b|\bgio\s+remove\b/i,
  /\bmv\b[^;&|]*\s\/dev\/null\b/i,
  /\btruncate\s+-s\s*0\b/i,
];
const SYSTEM_SH = [
  /(^|[;&|(\s])(sudo|pkexec|su|doas)(\s|$)/,
  /\bsystemctl\s+(?!(--user\s+)?(status|is-active|is-enabled|list-units|list-timers|show|cat)\b)/i,
  /\b(ufw|iptables|nft|firewall-cmd|passwd|chpasswd|chsh|usermod|useradd|userdel|groupadd|visudo|mount|umount|modprobe|insmod|rmmod|update-alternatives|grub-\w+|efibootmgr|cryptsetup|fdisk|parted)\b/i,
  /\b(reboot|shutdown|poweroff|halt)\b|\bsystemctl\s+(suspend|hibernate)\b|\bloginctl\s+(terminate|kill)/i,
  /\bnmcli\s+(?!(-\S+\s+)*(dev(ice)?\s+(status|show|wifi\s+list)|con(nection)?\s+show|general|radio\s*$))/i,
  /\bgsettings\s+(set|reset)\s+(?!org\.gnome\.desktop\.(background|interface|sound|screensaver\s+picture)|org\.gnome\.settings-daemon\.plugins\.color)/i,
  /\bcrontab\s+-[re]\b|\bchmod\s+(-\w+\s+)*[0-7]*[^;&|]*\s\/(etc|usr|bin|boot|var)\b|\bchmod\s+-R\b|\bchown\b/i,
  /(>|\btee\b)\s*(-a\s+)?\/etc\//,
  // running code fetched from the internet (the classic injected "curl … | bash")
  /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)|\b(curl|wget)\b[^;&|]*\|\s*(python3?|perl|node)\b/i,
  // credentials leaving the machine through stdout = the model sees them: ask
  /(\.ssh\/|\.gnupg|\.password-store|\bid_(rsa|ed25519|ecdsa)\b|\.friday-node|access-token|keyrings?\/|\.netrc|(^|[\s/])\.env\b|secret-tool\s+lookup|\bprintenv\b|^\s*env\s*$)/i,
];
const SEND_SH = [
  /\b(mail|mailx|sendmail|mutt|msmtp|swaks|neomutt)\b/i,
  /\bgit\s+push\b/i, /\bgh\s+(pr\s+(create|merge|comment|review)|issue\s+(create|comment|close)|release\s+create|repo\s+(create|delete)|gist\s+create|api\b)/i,
  /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bcargo\s+publish\b|\bvercel\b[^;&|]*--prod|\bnetlify\s+deploy\b/i,
  /\bcurl\b[^;&|]*(\s-(d|F|T)\b|--data|--form|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))/i,
  /\bwget\b[^;&|]*--(post|method)/i, /\bhttp(ie)?\s+(POST|PUT|PATCH|DELETE)\b/,
  /\b(scp|sftp|rsync)\b[^;&|]*\s[\w.-]+@?[\w.-]*:/i,
  /\b(telegram-send|slack-cli|notify-send\s+--remote|twurl)\b/i,
];

// -> { cat, risk, why }
export function classifyShell(command) {
  const c = String(command ?? '');
  if (DELETE_SH.some((r) => r.test(c))) return { cat: 'deletion', risk: 'consequential', why: 'deletes data or uninstalls software' };
  if (SYSTEM_SH.some((r) => r.test(c))) return { cat: 'system', risk: 'consequential', why: 'changes system/security settings or touches credentials' };
  if (SEND_SH.some((r) => r.test(c))) return { cat: 'messaging', risk: 'consequential', why: 'sends or publishes something to another person/service' };
  return { cat: 'computer', risk: 'routine', why: 'local command' };
}

// Desktop clicks on these (system Settings, installers, account screens) change the machine itself.
export const SYSTEM_RE = /\b(firewall|password|passcode|security|privacy|lock screen|users?|administrator|authenticat\w*|encryption|firmware|secure boot|remote (desktop|login)|file sharing|ssh|format (disk|drive)|factory reset|reset settings|install updates?)\b/i;
// Typing into one of these and pressing Enter sends a message.
export const SEND_CONTEXT_RE = /\b(message|messages|chat|reply|comment|e-?mail|mail|post|tweet|dms?|whats ?app|telegram|slack|discord|signal|teams|messenger|compose|composer|inbox|thread)\b/i;
export const SEND_KEYS_RE = /^(enter|return|kp_?enter|(ctrl|control|cmd|super|alt)\+(enter|return))$/i;
