const APP_PORT = 8081;
//var JQUERY_JS = "jquery-2.1.4.min.js";
var JQUERY_JS = "jquery-3.2.1.min.js";
var PAGE_JS = "page.js";
var apiUrl = "http://localhost:" + APP_PORT + "/";

var pageErrors = [];
let networkRequests = new Map(); // map[requestId, {requestData}]
var activeFrameId = 0;
var activeWindowId = -1;
var contentScriptCode = "";
var isTerminateNextAction = false;

chrome.runtime.onMessage.addListener(pageErrorsListener);

chrome.browserAction.onClicked.addListener(mainButtonClick);

getFileContents(JQUERY_JS, function(contents1) {
  getFileContents(PAGE_JS, function(content2) {
    contentScriptCode = contents1 + content2;
    setupSocketClient(apiUrl);
  });
});

function setupSocketClient(apiUrl) {
  console.log("Initializing websocket client ...");

  var socket = io.connect(apiUrl);

  socket.on("cmd", function(data) {
    console.log("cmd: " + data.cmd);

    if (isTerminateNextAction) {
      isTerminateNextAction = false;
      data.requestExpiry = 0; // this short-circuits the socket-server retry logic
      data.error_code = 404;
      data.error_message = "User Cancelled";
      socket.emit("cmd_out", data);
    } else {
      data.frameId = activeFrameId;
      runActionInBrowser(socket, data);
    }
  });

  // extension is started and ready - notify the server
  socket.emit("chrome_ready");
}

function getFileContents(filename, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", chrome.extension.getURL(filename), true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState == XMLHttpRequest.DONE && xhr.status == 200) {
      callback(xhr.responseText);
    }
  };
  xhr.send();
}

function runActionInBrowser(socket, data) {
  switch (data.cmd) {
    case "get_views_info":
      var retval = [];
      chrome.windows.getAll({}, function(windows) {
        var remainingWindows = windows.length;

        windows.forEach(function(window) {
          console.log("chrome.windows.getAll - wid=", window.id);

          chrome.tabs.query({ windowId: window.id }, function(tabs) {
            remainingWindows--;
            tabs.forEach(function(tab) {
              var viewInfo = {
                id: tab.id,
                index: tab.index,
                isActive: tab.active,
                url: tab.url,
                title: tab.title,
                windowId: window.id,
                windowType: window.type,
                top: window.top,
                left: window.left,
                width: window.width,
                height: window.height,
                state: window.state
              };
              retval.push(viewInfo);
            });

            if (remainingWindows === 0) {
              // we are done!
              data.retVal = retval;
              socket.emit("cmd_out", data);
              console.log("--" + data.cmd + " done:", data);
            }
          });
        });
      });

      break;

    case "set_active_view":
      chrome.tabs.update(data.tabId, { active: true }, function(tabs) {
        if (chrome.runtime.lastError) {
          console.log("--" + data.cmd + " error");
          data.error_code = 500;
          data.error_message = chrome.runtime.lastError.message;
          socket.emit("cmd_out", data);
          return;
        }
        activeWindowId = tabs.windowId;
        socket.emit("cmd_out", data);
        console.log("--" + data.cmd + " done:", data);
      });
      break;

    case "close_view":
      chrome.tabs.remove(data.tabId, function(tabs) {
        if (chrome.runtime.lastError) {
          console.log("--" + data.cmd + " error");
          data.error_code = 500;
          data.error_message = chrome.runtime.lastError.message;
          socket.emit("cmd_out", data);
          return;
        }

        socket.emit("cmd_out", data);
        console.log("--" + data.cmd + " done:", data);
      });
      break;

    case "set_views_info":
      getActiveWindow(function(wind) {
        var updateInfo = {};
        // data is passed as string, we cannot use || since a top/left position of (0,0) should be supported
        if (data.top) updateInfo.top = parseInt(data.top);
        if (data.left) updateInfo.left = parseInt(data.left);
        if (data.width) updateInfo.width = parseInt(data.width);
        if (data.height) updateInfo.height = parseInt(data.height);
        if (data.state) updateInfo.state = data.state;

        chrome.windows.update(wind.id, updateInfo, function(window) {
          socket.emit("cmd_out", data);
        });
      });
      break;

    case "get_errors":
      data.retVal = pageErrors;
      socket.emit("cmd_out", data);
      console.log("--" + data.cmd + " done:", data);
      break;

    case "clear_errors":
      pageErrors = [];
      socket.emit("cmd_out", data);
      console.log("--" + data.cmd + " done:", data);
      break;

    default:
      // runs all other actions in the current window & tab
      findActiveTabAndRunAction(socket, data);
  }
}

function getActiveWindow(cb) {
  if (activeWindowId === -1) {
    chrome.windows.getCurrent({}, window => cb(window));
  } else {
    chrome.windows.get(activeWindowId, {}, window => cb(window));
  }
}

function findActiveTabAndRunAction(socket, data) {
  getActiveWindow(function(window) {
    try {
      chrome.tabs.query(
        {
          windowId: window.id,
          active: true
        },
        function(tabs) {
          tab = tabs[0]; // only work with the active tab - and there is only one active tab!
          runActionInActivePage(socket, tab, data);
        }
      );
    } catch (err) {
      console.log("-- ERROR: " + err.message);
      data.error_code = 500;
      data.error_message = err.message;
      socket.emit("cmd_out", data);
    }
  });
}

function runActionInActivePage(socket, tab, data) {
  if (tab === undefined) {
    console.log("--" + data.cmd + " error");
    data.error_code = 501;
    data.error_message = "ERROR: Unable to find the active tab";
    socket.emit("cmd_out", data);
    return;
  }

  switch (data.cmd) {
    case "get_url":
      data.retVal = tab.url;
      socket.emit("cmd_out", data);
      console.log("--" + data.cmd + " done");
      break;

    case "set_url":
      function tabUpdatedListener(tabId, changeInfo, tab) {
        console.log("--status=" + changeInfo.status + " url=" + tab.url);
        if (changeInfo.status == "complete" && tab.url !== "about:blank") {
          /* timing issue where about:blank will be 'complete' before socket connection occurs before the about:blank tab is created*/
          chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
          socket.emit("cmd_out", data);
          console.log("--" + data.cmd + " done");
        }
      }

      chrome.tabs.onUpdated.addListener(tabUpdatedListener);

      // updates the url - response will be sent after the page load is complete - see above
      chrome.tabs.update(tab.id, { url: data.value });
      break;

    case "screenshot":
      chrome.tabs.captureVisibleTab(
        tab.windowId,
        { format: "jpeg", quality: 70 },
        function(dataUrl) {
          data.retVal = dataUrl;
          socket.emit("cmd_out", data);
          console.log("--" + data.cmd + " done");
        }
      );
      break;

    case "enable_network_stats":
      parseIncomingNetworkMessage();
      socket.emit("cmd_out", data);
      break;

    case "get_network_stats_latest_timestamp":
    case "get_network_stats":
      let networkStatsArray = Array.from(networkRequests.values());
      switch (data.cmd) {
        case "get_network_stats_latest_timestamp":
          const latestTimeStamp = networkStatsArray.reduce(
            (last, current) =>
              current.startTime > last ? current.startTime : last,
            0
          );
          data.retVal = latestTimeStamp;
          break;

        case "get_network_stats":
          if (data.path) {
            // lowerbound value specified in the path, for instance: http://restbot/955664.555762?get_network_stats instead of http://restbot/?get_network_stats
            const lowerBoundTimeStamp = parseFloat(data.path);
            networkStatsArray = networkStatsArray.filter(
              current => current.startTime > lowerBoundTimeStamp
            );
          }

          const sortedNetworkStats = networkStatsArray.sort((a, b) => {
            if (a.startTime > b.startTime) {
              return 1;
            }
            if (a.startTime < b.startTime) {
              return -1;
            }
            return 0;
          });
          data.retVal = sortedNetworkStats;
          break;
      }

      socket.emit("cmd_out", data);
      break;

    case "send_key":
      var tabId = tab.id;
      var debuggeeId = { tabId: tabId };
      attachOrReuseDebugger(debuggeeId, function() {
        const keyEventType = data.keyEventType || "rawKeyDown"; // rawKeyDown, char
        const keyEventText = data.keyEventText;

        chrome.debugger.sendCommand(
          debuggeeId,
          "Input.dispatchKeyEvent",
          { type: keyEventType, text: keyEventText },
          function(result) {
            data.retVal = result;
            socket.emit("cmd_out", data);
          }
        );
      });
      break;

    case "fullpage_screenshot":
      var tabId = tab.id;
      var debuggeeId = { tabId: tabId };

      attachOrReuseDebugger(debuggeeId, function() {
        chrome.debugger.sendCommand(
          debuggeeId,
          "Page.getLayoutMetrics",
          function(metrics) {
            const widthIncreaseFactor = data.widthIncreaseFactor || 1;
            const heightIncreaseFactor = data.heightIncreaseFactor || 1;
            const width =
              widthIncreaseFactor * Math.ceil(metrics.contentSize.width);
            const height =
              heightIncreaseFactor * Math.ceil(metrics.contentSize.height);

            chrome.debugger.sendCommand(
              debuggeeId,
              "Emulation.setDeviceMetricsOverride",
              {
                width: width,
                height: height,
                deviceScaleFactor: 1,
                mobile: false,
                dontSetVisibleSize: false
              },
              function() {
                /*chrome.debugger.sendCommand(debuggeeId, "Emulation.setVisibleSize", {
                            width: width,
                            height: height,
                        }, function () {
                        */
                setTimeout(async function() {
                  chrome.debugger.sendCommand(
                    debuggeeId,
                    "Page.captureScreenshot",
                    { format: "png", quality: 100 },
                    function(result) {
                      data.retVal = result;
                      socket.emit("cmd_out", data);
                    }
                  );
                }, 1000); /* enough time for chrome to process the changes (even though we are running in a callback!!?!) */
              }
            );
          }
        );
      });
      break;

    case "switch_frame":
      var urlFragment = data.value;
      chrome.webNavigation.getAllFrames({ tabId: tab.id }, function(
        framesInfo
      ) {
        for (let { frameId, url } of framesInfo) {
          if (url.includes(urlFragment)) {
            activeFrameId = frameId;
            socket.emit("cmd_out", data);
            return;
          }
        }

        data.error_code = 404;
        data.error_message = 'Frame with path "' + urlFragment + '" not found';
        socket.emit("cmd_out", data);
      });
      break;

    case "reset_frame":
      activeFrameId = 0;
      socket.emit("cmd_out", data);
      break;

    case "close_active_view":
      chrome.tabs.remove(tab.id, function(tabs) {
        if (chrome.runtime.lastError) {
          console.log("--" + data.cmd + " error");
          data.error_code = 500;
          data.error_message = chrome.runtime.lastError.message;
          socket.emit("cmd_out", data);
          return;
        }

        socket.emit("cmd_out", data);
      });
      break;

    default:
      sendMessageIntoTab(tab.id, data, function(response) {
        console.log("response:", JSON.stringify(response));

        if (typeof response == "undefined") {
          setTimeout(function() {
            console.log(
              `___ delay restart send message - tabId=${tab.id}, frameId=${
                data.frameId
              }`
            );
            // try again, case when page moved
            findActiveTabAndRunAction(socket, data);
          }, 500);
        } else {
          if (response.data.error_code)
            console.log(
              "error response received from page: " +
                response.data.error_message
            );

          socket.emit("cmd_out", response.data);
          console.log("--" + data.cmd + " done");
        }
      });
      break;
  }
}

// sends the message into the page - only after having checked that the dependencies are injected
function sendMessageIntoTab(tabId, data, callback) {
  var details = { tabId: tabId, frameId: data.frameId };
  var dependency_key = `${tabId}-${data.frameId}`;

  console.log(`-- sendMessageIntoTab - ${tabId} - ${JSON.stringify(data)}`);
  chrome.webNavigation.getFrame(details, function(info) {
    console.log(`-- getFrame - ${JSON.stringify(info)}`);
    chrome.tabs.sendMessage(
      tabId,
      { data: data },
      { frameId: data.frameId },
      function(response) {
        if (response) {
          console.log(
            `-- chrome.tabs.sendMessage-RESPONSE - ${JSON.stringify(response)}`
          );
          callback(response);
        } else {
          console.log(`-- chrome.tabs.sendMessage-ELSE-1`);
          chrome.tabs.executeScript(
            tabId,
            {
              code: contentScriptCode,
              allFrames: true,
              frameId: data.frameId,
              runAt: "document_start"
            },
            function(resp) {
              console.log(`-- chrome.tabs.sendMessage-ELSE-2`);
              callback(); // after dependencies are injected, this will invoke callback() with no params, which triggers a retry
            }
          );
        }
      }
    );
  });
}

function pageErrorsListener(request) {
  if (request.cmd === "page_error") {
    console.log("errorData:", request.data);
    pageErrors.push(request.data);
  }
}

function mainButtonClick() {
  isTerminateNextAction = true;
}

function attachOrReuseDebugger(debuggeeId, callback) {
  var version = "1.0";

  chrome.debugger.getTargets(function(targets) {
    const alreadyAttached =
      targets.filter(
        ({ attached, tabId }) => attached && tabId === debuggeeId.tabId
      ).length > 0;
    if (alreadyAttached) callback();
    else chrome.debugger.attach(debuggeeId, version, callback);
  });
}

function parseIncomingNetworkMessage() {
  var tabId = tab.id;
  var debuggeeId = { tabId: tabId };

  let round2 = nb => Math.round(nb * 1e2) / 1e2;

  const setNetworkResponseFinished = function(requestData, params) {
    requestData.length = params.encodedDataLength;
    requestData.totalTime = round2(
      1000 * (params.timestamp - requestData.startTime)
    );
    return requestData;
  };

  const setNetworkResponseData = function(requestData, response) {
    if (response.protocol === "data")
      // when protocol== data, the url is the data itself (this polutes the logs)
      requestData.url = "data:[...]";
    else requestData.url = response.url;

    var chromeTiming = response.timing;
    var timing = {};
    if (chromeTiming) {
      timing.dns = round2(chromeTiming.dnsEnd - chromeTiming.dnsStart);
      timing.initialConnection = round2(
        chromeTiming.connectEnd - chromeTiming.connectStart
      );
      timing.ssl = round2(chromeTiming.sslEnd - chromeTiming.sslStart);
      timing.requestSent = round2(
        chromeTiming.sendEnd - chromeTiming.sendStart
      );
    }

    requestData.type = response.mimeType;
    requestData.status = response.status;
    requestData.timing = timing;
    if (response.status !== 200) requestData.statusText = response.statusText;

    return requestData;
  };

  attachOrReuseDebugger(debuggeeId, function() {
    chrome.debugger.sendCommand(debuggeeId, "Network.enable");
    chrome.debugger.sendCommand(debuggeeId, "Runtime.enable");

    chrome.debugger.onEvent.addListener(function(debuggeeId, message, params) {
      if (message === "Runtime.exceptionThrown" && params.exceptionDetails) {
        pageErrors.push({
          message: params.exceptionDetails.text,
          baseURI: params.exceptionDetails.url,
          exception: params.exceptionDetails.exception
        });
        return;
      }

      if (message === "Network.requestWillBeSent") {
        // special case: if it has a 'redirectResponse', use it to "finilize" the initial request
        if (params.redirectResponse) {
          var requestData = networkRequests.get(params.requestId);
          if (requestData) {
            requestData = setNetworkResponseData(
              requestData,
              params.redirectResponse
            );
            requestData = setNetworkResponseFinished(requestData, params);
            // generate a new requestId for the old one (else it will be overwritten!)
            networkRequests.set(newGuid(), requestData);
          }
        }

        networkRequests.set(params.requestId, {
          startTime: params.timestamp,
          method: params.request.method,
          url: params.request.url,
          status: 0 // can be used to identify pending requests
        });
      } else if (message === "Network.responseReceived") {
        var requestData = networkRequests.get(params.requestId);
        if (requestData === undefined)
          /* case we receive events that started before the capturing started */
          return;

        requestData = setNetworkResponseData(requestData, params.response);
      } else if (message === "Network.loadingFinished") {
        var requestData = networkRequests.get(params.requestId);
        if (requestData === undefined)
          /* case we receive events that started before the capturing started */
          return;

        requestData = setNetworkResponseFinished(requestData, params);
      }
    });
  });
}

function newGuid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }

  return (
    s4() +
    s4() +
    "-" +
    s4() +
    "-" +
    s4() +
    "-" +
    s4() +
    "-" +
    s4() +
    s4() +
    s4()
  );
}
