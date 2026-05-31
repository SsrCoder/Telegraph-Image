export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search
    if (url.pathname.length > 39) { // Path length > 39 indicates file uploaded via Telegram Bot API
        const formdata = new FormData();
        formdata.append("file_id", url.pathname);

        const requestOptions = {
            method: "POST",
            body: formdata,
            redirect: "follow"
        };
        // /file/AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA.png
        //get the AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA
        console.log(url.pathname.split(".")[0].split("/")[2])
        const filePath = await getFilePath(env, url.pathname.split(".")[0].split("/")[2]);
        console.log(filePath)
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    const rawResponse = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    // If the response is not OK, return it directly
    if (!rawResponse.ok) return rawResponse;

    // 移除 Content-Disposition 头，使浏览器直接展示内容而非触发下载
    const respHeaders = new Headers(rawResponse.headers);
    respHeaders.delete('Content-Disposition');

    // 优先使用上游返回的 Content-Type，仅在缺失或为通用类型时根据扩展名补充
    const upstreamType = respHeaders.get('Content-Type');
    if (!upstreamType || upstreamType === 'application/octet-stream') {
        const ext = params.id.split('.').pop()?.toLowerCase();
        const mimeType = getMimeType(ext);
        if (mimeType) {
            respHeaders.set('Content-Type', mimeType);
        }
    }

    const response = new Response(rawResponse.body, {
        status: rawResponse.status,
        statusText: rawResponse.statusText,
        headers: respHeaders,
    });

    // Log response details
    console.log(response.ok, response.status);

    // Allow the admin page to directly view the image
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return response;
    }

    // Check if KV storage is available
    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return response;  // Directly return image response, terminate execution
    }

    // The following code executes only if KV is available
    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        // Initialize metadata if it doesn't exist
        console.log("Metadata not found, initializing...");
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // Handle based on ListType and Label
    if (metadata.ListType === "White") {
        return response;
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // Check if WhiteList_Mode is enabled
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // If no metadata or further actions required, moderate content and add to KV if needed
    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        console.log("Content marked as adult, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Error during content moderation: " + error.message);
            // Moderation failure should not affect user experience, continue processing
        }
    }

    // Only save metadata if content is not adult content
    // Adult content cases are already handled above and will not reach this point
    console.log("Saving metadata");
    await env.img_url.put(params.id, "", { metadata });

    // Return file content
    return response;
}

function getMimeType(ext) {
    const mimeTypes = {
        // 图片
        'jpg':  'image/jpeg',
        'jpeg': 'image/jpeg',
        'png':  'image/png',
        'gif':  'image/gif',
        'webp': 'image/webp',
        'svg':  'image/svg+xml',
        'bmp':  'image/bmp',
        'ico':  'image/x-icon',
        // 视频
        'mp4':  'video/mp4',
        'webm': 'video/webm',
        'ogg':  'video/ogg',
        'mov':  'video/quicktime',
        // 音频
        'mp3':  'audio/mpeg',
        'wav':  'audio/wav',
        'flac': 'audio/flac',
        'aac':  'audio/aac',
        'opus': 'audio/opus',
        // 文档
        'pdf':  'application/pdf',
    };
    return mimeTypes[ext] || null;
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, {
            method: 'GET',
        });

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const responseData = await res.json();
        const { ok, result } = responseData;

        if (ok && result) {
            return result.file_path;
        } else {
            console.error('Error in response data:', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}