//! The launcher's built-in entries: Windows settings pages, classic system
//! tools, and commands for the dock and the computer. Each has an English
//! and a Turkish name plus extra words people type for it ("wallpaper",
//! "duvar kağıdı"), and both languages always match.

/// What a built-in entry does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A Settings page or a system tool: opened with the shell.
    Setting,
    /// A dock or computer command, run by `palette::run`.
    Command,
}

pub struct Builtin {
    pub kind: Kind,
    /// What runs: an `ms-settings:` page, a program, or a command id.
    pub target: &'static str,
    pub args: &'static str,
    pub en: &'static str,
    pub tr: &'static str,
    /// Extra words to match, in both languages.
    pub words: &'static str,
    /// The dock's icon name (src/lib/icons.js).
    pub glyph: &'static str,
    /// Asks for a second Enter first (shut down, empty the bin…).
    pub confirm: bool,
}

const fn page(target: &'static str, en: &'static str, tr: &'static str, words: &'static str) -> Builtin {
    Builtin { kind: Kind::Setting, target, args: "", en, tr, words, glyph: "gear", confirm: false }
}

const fn tool(target: &'static str, args: &'static str, en: &'static str, tr: &'static str, words: &'static str, glyph: &'static str) -> Builtin {
    Builtin { kind: Kind::Setting, target, args, en, tr, words, glyph, confirm: false }
}

const fn cmd(target: &'static str, en: &'static str, tr: &'static str, words: &'static str, glyph: &'static str, confirm: bool) -> Builtin {
    Builtin { kind: Kind::Command, target, args: "", en, tr, words, glyph, confirm }
}

pub static BUILTINS: &[Builtin] = &[
    // Windows Settings pages.
    page("ms-settings:display", "Display settings", "Ekran ayarları", "brightness resolution scale monitor parlaklık çözünürlük ölçek monitör"),
    page("ms-settings:nightlight", "Night light", "Gece ışığı", "blue light mavi ışık"),
    page("ms-settings:sound", "Sound settings", "Ses ayarları", "audio speakers microphone hoparlör mikrofon"),
    page("ms-settings:apps-volume", "Volume mixer", "Ses karıştırıcı", "app volume uygulama ses düzeyi"),
    page("ms-settings:notifications", "Notification settings", "Bildirim ayarları", "alerts uyarılar"),
    page("ms-settings:quiethours", "Focus and do not disturb", "Odak ve rahatsız etmeyin", "focus assist dnd sessiz"),
    page("ms-settings:powersleep", "Power and sleep", "Güç ve uyku", "battery screen off pil ekran kapanma"),
    page("ms-settings:batterysaver", "Battery saver", "Pil tasarrufu", "battery pil enerji"),
    page("ms-settings:storagesense", "Storage", "Depolama", "disk space cleanup disk alanı temizleme"),
    page("ms-settings:multitasking", "Multitasking", "Çoklu görev", "snap windows alt tab pencere yaslama"),
    page("ms-settings:clipboard", "Clipboard settings", "Pano ayarları", "clipboard history pano geçmişi"),
    page("ms-settings:about", "About this PC", "Bu bilgisayar hakkında", "system info specs rename pc sistem bilgisi özellikler bilgisayar adı"),
    page("ms-settings:bluetooth", "Bluetooth and devices", "Bluetooth ve cihazlar", "pair headphones eşleştir kulaklık"),
    page("ms-settings:printers", "Printers and scanners", "Yazıcılar ve tarayıcılar", "print yazdır"),
    page("ms-settings:mousetouchpad", "Mouse", "Fare", "pointer cursor imleç"),
    page("ms-settings:devices-touchpad", "Touchpad", "Dokunmatik yüzey", "gestures hareketler"),
    page("ms-settings:typing", "Typing", "Yazma", "autocorrect keyboard otomatik düzeltme klavye"),
    page("ms-settings:network-status", "Network and internet", "Ağ ve internet", "ethernet connection bağlantı"),
    page("ms-settings:network-wifi", "Wi-Fi", "Wi-Fi", "wireless kablosuz wlan"),
    page("ms-settings:network-vpn", "VPN", "VPN", "vpn"),
    page("ms-settings:network-proxy", "Proxy", "Ara sunucu", "proxy"),
    page("ms-settings:personalization-background", "Background", "Arka plan", "wallpaper desktop picture duvar kağıdı masaüstü resmi"),
    page("ms-settings:colors", "Colors", "Renkler", "dark mode light mode accent karanlık mod açık mod vurgu rengi"),
    page("ms-settings:themes", "Themes", "Temalar", "theme tema"),
    page("ms-settings:lockscreen", "Lock screen", "Kilit ekranı", "lock kilit"),
    page("ms-settings:fonts", "Fonts", "Yazı tipleri", "font yazı tipi"),
    page("ms-settings:taskbar", "Taskbar settings", "Görev çubuğu ayarları", "taskbar görev çubuğu"),
    page("ms-settings:appsfeatures", "Installed apps", "Yüklü uygulamalar", "uninstall remove programs kaldır programlar"),
    page("ms-settings:defaultapps", "Default apps", "Varsayılan uygulamalar", "browser open with tarayıcı birlikte aç"),
    page("ms-settings:startupapps", "Startup apps", "Başlangıç uygulamaları", "autostart boot açılışta başlat"),
    page("ms-settings:yourinfo", "Your account", "Hesabınız", "microsoft account profile hesap profil"),
    page("ms-settings:signinoptions", "Sign-in options", "Oturum açma seçenekleri", "password pin windows hello şifre parola"),
    page("ms-settings:dateandtime", "Date and time", "Tarih ve saat", "clock time zone saat dilimi"),
    page("ms-settings:regionlanguage", "Language and region", "Dil ve bölge", "keyboard layout input klavye düzeni"),
    page("ms-settings:gaming-gamebar", "Game Bar", "Oyun Çubuğu", "xbox record kayıt"),
    page("ms-settings:gaming-gamemode", "Game Mode", "Oyun Modu", "gaming oyun"),
    page("ms-settings:display-advancedgraphics", "Graphics settings", "Grafik ayarları", "gpu graphics card ekran kartı"),
    page("ms-settings:easeofaccess-display", "Accessibility", "Erişilebilirlik", "text size magnifier metin boyutu büyüteç"),
    page("ms-settings:privacy", "Privacy and security", "Gizlilik ve güvenlik", "permissions izinler"),
    page("ms-settings:privacy-microphone", "Microphone privacy", "Mikrofon izinleri", "mic mikrofon"),
    page("ms-settings:privacy-webcam", "Camera privacy", "Kamera izinleri", "webcam kamera"),
    page("ms-settings:windowsupdate", "Windows Update", "Windows Update", "updates güncellemeler güncelle"),
    page("ms-settings:windowsdefender", "Windows Security", "Windows Güvenliği", "antivirus defender virus firewall güvenlik duvarı virüs"),
    page("ms-settings:recovery", "Recovery", "Kurtarma", "reset this pc sıfırla"),
    // Classic tools people look for by name.
    tool("control.exe", "", "Control Panel", "Denetim Masası", "control panel", "sliders"),
    tool("devmgmt.msc", "", "Device Manager", "Aygıt Yöneticisi", "drivers sürücüler", "cpu"),
    tool("diskmgmt.msc", "", "Disk Management", "Disk Yönetimi", "partition format bölüm biçimlendir", "disk"),
    tool("services.msc", "", "Services", "Hizmetler", "service hizmet", "gear"),
    tool("eventvwr.msc", "", "Event Viewer", "Olay Görüntüleyicisi", "logs errors günlük hatalar", "info"),
    tool("taskmgr.exe", "", "Task Manager", "Görev Yöneticisi", "processes kill end task işlemler görevi sonlandır", "cpu"),
    tool("regedit.exe", "", "Registry Editor", "Kayıt Defteri Düzenleyicisi", "regedit registry kayıt defteri", "terminal"),
    tool("rundll32.exe", "sysdm.cpl,EditEnvironmentVariables", "Environment variables", "Ortam değişkenleri", "path env değişken", "terminal"),
    tool("ncpa.cpl", "", "Network connections", "Ağ bağlantıları", "adapter ethernet adaptör", "network"),
    tool("appwiz.cpl", "", "Programs and Features", "Programlar ve Özellikler", "uninstall kaldır", "apps"),
    tool("mmsys.cpl", "", "Sound devices", "Ses aygıtları", "playback recording kayıt oynatma", "speaker"),
    tool("shell:RecycleBinFolder", "", "Recycle Bin", "Geri Dönüşüm Kutusu", "trash deleted silinenler çöp", "trash"),
    tool("shell:Downloads", "", "Downloads", "İndirilenler", "downloads indirilenler", "download"),
    tool("shell:Personal", "", "Documents", "Belgeler", "documents belgeler", "folder"),
    tool("shell:Desktop", "", "Desktop folder", "Masaüstü klasörü", "desktop masaüstü", "desktop"),
    // The computer.
    cmd("sys:lock", "Lock the computer", "Bilgisayarı kilitle", "lock kilitle", "lock", false),
    cmd("sys:sleep", "Sleep", "Uyku", "sleep suspend uyut", "moon", false),
    cmd("sys:restart", "Restart", "Yeniden başlat", "reboot restart yeniden başlat", "restart", true),
    cmd("sys:shutdown", "Shut down", "Bilgisayarı kapat", "shutdown power off kapat", "power", true),
    cmd("sys:signout", "Sign out", "Oturumu kapat", "log off logout çıkış yap", "logout", true),
    cmd("sys:emptyBin", "Empty the Recycle Bin", "Geri Dönüşüm Kutusunu boşalt", "trash empty çöp boşalt", "trash", true),
    cmd("win:clipboard", "Clipboard history", "Pano geçmişi", "win v paste yapıştır", "clipboard", false),
    cmd("win:snip", "Take a screenshot", "Ekran görüntüsü al", "snip screenshot snipping tool ekran alıntısı", "scissors", false),
    cmd("win:desktop", "Show the desktop", "Masaüstünü göster", "minimize all hepsini küçült", "desktop", false),
    cmd("win:taskview", "Task View", "Görev Görünümü", "virtual desktops sanal masaüstleri", "taskview", false),
    cmd("win:notifications", "Notification center", "Bildirim merkezi", "calendar takvim", "bell", false),
    cmd("win:quicksettings", "Quick settings", "Hızlı ayarlar", "wifi bluetooth brightness parlaklık", "toggles", false),
    cmd("win:explorer", "File Explorer", "Dosya Gezgini", "explorer files dosyalar", "folder", false),
    cmd("win:run", "Run box", "Çalıştır kutusu", "win r run çalıştır", "terminal", false),
    // The dock.
    cmd("dock:settings", "Dynamic Dock settings", "Dynamic Dock ayarları", "dock settings preferences dock ayarları tercihler", "sliders", false),
    cmd("dock:nextBar", "Next bar", "Sonraki çubuk", "dock bar switch çubuk değiştir", "right", false),
    cmd("dock:previousBar", "Previous bar", "Önceki çubuk", "dock bar switch çubuk değiştir", "left", false),
    cmd("dock:toggleDock", "Hide or show the dock", "Dock'u gizle ya da göster", "dock hide gizle", "layers", false),
    cmd("dock:toggleCat", "Hide or show the cat", "Kediyi gizle ya da göster", "cat kedi", "cat", false),
    cmd("dock:toggleFps", "Start or stop the FPS counter", "FPS sayacını başlat ya da durdur", "fps frames kare", "gauge", false),
    cmd("dock:toggleFpsOverlay", "Show or hide the FPS counter on the screen", "FPS sayacını ekranda göster ya da gizle", "fps overlay game oyun", "gauge", false),
];
