const APP_PORT = 8081;
var apiUrl = 'http://localhost:' + APP_PORT + '/';

var pageErrors = [];
var activeFrameId = 0;
var dep_page = {};
var dep_jquery = {};

chrome.runtime.onMessage.addListener(pageErrorsListener);

// note: both events are required
chrome.webNavigation.onDOMContentLoaded.addListener(injectDependencies);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(injectDependencies);

setupSocketClient(apiUrl);

function setupSocketClient(apiUrl) {
    console.log('Initializing websocket client ...');

    var socket = io.connect(apiUrl);

    socket.on('cmd', function (data) {
        console.log('cmd: ' + data.cmd);
        data.frameId = activeFrameId;
        runActionInBrowser(socket, data);
    });

    // extension is started and ready - notify the server    
    socket.emit('chrome_ready');
}

function runActionInBrowser(socket, data) {
    switch (data.cmd) {
        case "get_views_info":
            var retval = [];
            chrome.windows.getAll({}, function (windows) {
                var remainingWindows = windows.length;

                windows.forEach(function (window) {
                    console.log('chrome.windows.getAll - wid=', window.id);

                    chrome.tabs.query({ windowId: window.id }, function (tabs) {
                        remainingWindows--;
                        tabs.forEach(function (tab) {
                            var viewInfo = {
                                id: tab.id,
                                index: tab.index,
                                isActive: tab.active,
                                url: tab.url, title:
                                tab.title,
                                windowId: window.id,
                                windowType: window.type,
                                top: window.top,
                                left: window.left,
                                width: window.width,
                                height: window.height
                            };
                            retval.push(viewInfo);
                        });

                        if (remainingWindows === 0) {
                            // we are done!
                            data.retVal = retval;
                            socket.emit('cmd_out', data);
                            console.log('--' + data.cmd + ' done:', data);
                        }
                    });
                });
            });

            break;

        case "set_active_view":
            chrome.tabs.update(data.tabId, { active: true }, function (tabs) {

                if (chrome.runtime.lastError) {
                    console.log('--' + data.cmd + ' error');
                    data.error_code = 500;
                    data.error_message = chrome.runtime.lastError.message;
                    socket.emit('cmd_out', data);
                    return;
                }

                socket.emit('cmd_out', data);
                console.log('--' + data.cmd + ' done:', data);
            });
            break;

        case "close_view":
            chrome.tabs.remove(data.tabId, function (tabs) {

                if (chrome.runtime.lastError) {
                    console.log('--' + data.cmd + ' error');
                    data.error_code = 500;
                    data.error_message = chrome.runtime.lastError.message;
                    socket.emit('cmd_out', data);
                    return;
                }

                socket.emit('cmd_out', data);
                console.log('--' + data.cmd + ' done:', data);
            });
            break;

        case "set_views_info":
            chrome.windows.getCurrent(function (wind) {
                var updateInfo = {};
                // data is passed as string, we cannot use || since a top/left position of (0,0) should be supported
                if (data.top)
                    updateInfo.top = parseInt(data.top)
                if (data.left)
                    updateInfo.left = parseInt(data.left)
                if (data.width)
                    updateInfo.width = parseInt(data.width)
                if (data.height)
                    updateInfo.height = parseInt(data.height)

                chrome.windows.update(wind.id, updateInfo, function (window) {
                    socket.emit('cmd_out', data);
                });
            });
            break;

        case "get_errors":
            data.retVal = pageErrors;
            socket.emit('cmd_out', data);
            console.log('--' + data.cmd + ' done:', data);
            break;

        case "clear_errors":
            pageErrors = [];
            socket.emit('cmd_out', data);
            console.log('--' + data.cmd + ' done:', data);
            break;

        case "pause":
            handlePause(socket, data);
            break;

        default:
            // runs all other actions in the current window & tab
            findActiveTabAndRunAction(socket, data);
    }
}

function handlePause(socket, data) {
    setExtensionIcon(true);
    chrome.browserAction.onClicked.addListener(function (tab) {
        socket.emit('cmd_out', data);
        setExtensionIcon();
    });
}

function findActiveTabAndRunAction(socket, data) {
    chrome.windows.getCurrent({}, function (window) {
        try {
            chrome.tabs.query({ active: true }, function (tabs) {
                tab = tabs[0]; // only work with the active tab - and there is only one active tab!             
                runActionInActivePage(socket, tab, data);
            });
        }
        catch (err) {
            console.log('-- ERROR: ' + err.message);
            data.error_code = 500;
            data.error_message = err.message;
            socket.emit('cmd_out', data);
        }
    });
}

function runActionInActivePage(socket, tab, data) {
    if (tab === undefined) {
        console.log('--' + data.cmd + ' error');
        data.error_code = 501;
        data.error_message = 'ERROR: Unable to find the active tab';
        socket.emit('cmd_out', data);
        return;
    }

    switch (data.cmd) {
        case "get_url":
            data.retVal = tab.url;
            socket.emit('cmd_out', data);
            console.log('--' + data.cmd + ' done');
            break;

        case "set_url":
            function tabUpdatedListener(tabId, changeInfo, tab) {
                console.log('--status=' + changeInfo.status + ' url=' + tab.url);
                if (changeInfo.status == 'complete' && tab.url !== 'about:blank') { /* timing issue where about:blank will be 'complete' before socket connection occurs before the about:blank tab is created*/
                    chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
                    socket.emit('cmd_out', data);
                    console.log('--' + data.cmd + ' done');
                }
            }

            chrome.tabs.onUpdated.addListener(tabUpdatedListener);

            // updates the url - response will be sent after the page load is complete - see above
            chrome.tabs.update(tab.id, { url: data.value });
            break;

        case "screenshot":
            chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }, function (dataUrl) {
                data.retVal = dataUrl;
                socket.emit('cmd_out', data);
                console.log('--' + data.cmd + ' done');
            });
            break;

        case "fullpage_screenshot":
            var tabId = tab.id;
            var version = "1.0";
            var debuggeeId = { tabId: tabId };
            let clip = {};

            chrome.debugger.attach(debuggeeId, version, function () {
                chrome.debugger.sendCommand(debuggeeId, "Page.getLayoutMetrics", function (metrics) {
                    const width = Math.ceil(metrics.contentSize.width);
                    const height = Math.ceil(metrics.contentSize.height);
                    clip = { x: 0, y: 0, width, height, scale: 1 };
                    chrome.debugger.sendCommand(debuggeeId, "Emulation.setDeviceMetricsOverride", {
                        width: width,
                        height: height,
                        deviceScaleFactor: 1,
                        mobile: false,
                        dontSetVisibleSize: false
                    }, function () {
                        /*chrome.debugger.sendCommand(debuggeeId, "Emulation.setVisibleSize", {
                            width: width,
                            height: height,
                        }, function () {
                        */
                        setTimeout(async function () {
                            chrome.debugger.sendCommand(debuggeeId, "Page.captureScreenshot", { format: "png", quality: 100 },
                                function (result) {
                                    data.retVal = result;
                                    socket.emit('cmd_out', data);
                                });
                        }, 1000); /* enough time for chrome to process the changes (even though we are running in a callback!!?!) */
                    });
                });
            });
            break;

        case "get_frames":
            chrome.webNavigation.getAllFrames({ tabId: tab.id }, function (framesInfo) {
                data.retVal = framesInfo;
                socket.emit('cmd_out', data);
            });
            break;

        case "switch_frame":
            activeFrameId = parseInt(data.value);
            socket.emit('cmd_out', data);
            break;

        case "close_active_view":
            chrome.tabs.remove(tab.id, function (tabs) {

                if (chrome.runtime.lastError) {
                    console.log('--' + data.cmd + ' error');
                    data.error_code = 500;
                    data.error_message = chrome.runtime.lastError.message;
                    socket.emit('cmd_out', data);
                    return;
                }

                socket.emit('cmd_out', data);
            });
            break;

        default:
            sendMessageIntoTab(tab.id, data, function (response) {
                console.log('response:', JSON.stringify(response));

                if (response === undefined)
                    // try again, case when page moved
                    runActionInActivePage(socket, tab, data);

                else if (response.data.error_code)
                    console.log('error response received from page: ' + response.data.error_message);

                socket.emit('cmd_out', response.data);
                console.log('--' + data.cmd + ' done');
            });
            break;
    }
}

function injectDependencies(details) {
    var url = details.url;
    var tabId = details.tabId;
    var frameId = details.frameId;
    var dependency_key = `${tabId}-${frameId}`;

    if (url.startsWith("chrome://"))
        return;

    var JQUERY_JS = "jquery-2.1.4.min.js";
    var PAGE_JS = "page.js";

    dep_jquery[dependency_key] = "";
    dep_page[dependency_key] = "";

    chrome.tabs.executeScript(tabId, { file: JQUERY_JS, allFrames: true }, function (res1) {
        dep_jquery[dependency_key] = url;
        chrome.tabs.executeScript(tabId, { file: PAGE_JS, allFrames: true }, function (res2) {
            dep_page[dependency_key] = url;
        });
    });
}

// sends the message into the page - only after having checked that the dependencies are injected
function sendMessageIntoTab(tabId, data, callback) {
    var details = { tabId: tabId, frameId: data.frameId };
    var dependency_key = `${tabId}-${data.frameId}`;

    chrome.webNavigation.getFrame(details, function (info) {
        if (info && (dep_jquery[dependency_key] === info.url && (dep_page[dependency_key] === info.url))) {
            chrome.tabs.sendMessage(
                tabId,
                { data: data },
                { frameId: data.frameId },
                function (response) {
                    callback(response);
                });
        }
        else {
            setTimeout(function () {
                console.log(`___ delay restart send message - tabId=${tabId}, frameId=${data.frameId}, info=`, info);
                sendMessageIntoTab(tabId, data, callback);
            }, 500);
        }
    });
}

function pageErrorsListener(request) {
    if (request.cmd === 'page_error') {
        console.log('errorData:', request.data);
        pageErrors.push(request.data);
    }
}

function setExtensionIcon(isPauseIcon) {
    let iconPath = 'default.png';
    if (isPauseIcon)
        iconPath = 'play4.png';

    chrome.browserAction.setIcon({ path: iconPath });
}