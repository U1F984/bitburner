import React, { useEffect, useRef, useState } from "react";
import { EventEmitter } from "../../utils/EventEmitter";
import { RunningScript } from "../../Script/RunningScript";
import { killWorkerScript } from "../../Netscript/killWorkerScript";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Draggable from "react-draggable";
import { ResizableBox } from "react-resizable";
import makeStyles from "@mui/styles/makeStyles";
import createStyles from "@mui/styles/createStyles";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import { workerScripts } from "../../Netscript/WorkerScripts";
import { startWorkerScript } from "../../NetscriptWorker";
import { GetServer } from "../../Server/AllServers";
import { Theme } from "@mui/material";
import { findRunningScript } from "../../Script/ScriptHelpers";
import { Player } from "../../Player";
import { debounce } from "lodash";
import { Settings } from "../../Settings/Settings";
import { LogWindowContent } from "./LogWindowContent";
import {
  ICrossWindowMessage,
  ICrossWindowMessageCommand,
  ICrossWindowMessageUpdate,
  makeMessage,
  retrieveMessage,
} from "./messaging";

let layerCounter = 0;

export const LogBoxEvents = new EventEmitter<[RunningScript]>();
export const LogBoxCloserEvents = new EventEmitter<[number]>();
export const LogBoxClearEvents = new EventEmitter<[]>();

interface Log {
  id: string;
  script: RunningScript;
  foreignWindow: WindowProxy | null;
}

let logs: Log[] = [];

function kill(script: RunningScript): void {
  workerScripts.has(script.pid) && killWorkerScript(script, script.server, true);
}

function run(script: RunningScript): RunningScript | null {
  const server = GetServer(script.server);
  if (server === null) return null;
  const s = findRunningScript(script.filename, script.args, server);
  if (s === null) {
    startWorkerScript(Player, script, server);
    return script;
  } else {
    return s;
  }
}

export function LogBoxManager(): React.ReactElement {
  const setRerender = useState(true)[1];

  function rerender(): void {
    setRerender((o) => !o);
  }

  useEffect(
    () =>
      LogBoxEvents.subscribe((script: RunningScript) => {
        const id = script.server + "-" + script.filename + script.args.map((x: any): string => `${x}`).join("-");
        if (logs.find((l) => l.id === id)) return;
        logs.push({
          id: id,
          script: script,
          foreignWindow: null,
        });
        rerender();
      }),
    [],
  );

  //Event used by ns.closeTail to close tail windows
  useEffect(
    () =>
      LogBoxCloserEvents.subscribe((pid: number) => {
        closePid(pid);
      }),
    [],
  );

  useEffect(() =>
    LogBoxClearEvents.subscribe(() => {
      logs = [];
      rerender();
    }),
  );

  function broadcast(): void {
    logs.forEach((log) => {
      const foreignWindow = log.foreignWindow;
      if (!foreignWindow) return;
      if (foreignWindow.closed) {
        log.foreignWindow = null;
        rerender();
        return;
      }

      const message: ICrossWindowMessage<ICrossWindowMessageUpdate> = makeMessage({
        filename: log.script.filename,
        args: log.script.args,
        logs: log.script.logs,
        running: workerScripts.has(log.script.pid),
      });
      foreignWindow.postMessage(message, location.origin);
    });
  }

  useEffect(() => {
    const id = setInterval(broadcast, 1000);
    return () => clearInterval(id);
  }, []);

  function onMessage(event: MessageEvent): void {
    const sender = event.source;
    const type = retrieveMessage<ICrossWindowMessageCommand>(event.data);
    if (!type) return;

    const log = logs.find((log) => log.foreignWindow === sender);
    if (!log) return;
    if (type.command === "run") {
      const newScript = run(log.script);
      if (newScript && newScript !== log.script) {
        log.script = newScript;
      }
    } else if (type.command === "kill") {
      kill(log.script);
    } else if (type.command === "close") {
      // window will close itself, just cleanup and rerender to make experience
      // smoother
      close(log.id);
    }
  }

  useEffect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  //Close tail windows by their id
  function close(id: string): void {
    logs = logs.filter((l) => l.id !== id);
    rerender();
  }

  //Close tail windows by their pid
  function closePid(pid: number): void {
    logs = logs.filter((log) => log.script.pid != pid);
    rerender();
  }

  function openExternally(log: Log): void {
    if (log.foreignWindow) return;
    const relativePath = process.env.NODE_ENV === "development" ? "./log/index.html" : "./dist/log/index.html";
    const url = new URL(relativePath, window.location.href);
    log.foreignWindow = window.open(url, "_blank", "popup");
    rerender();
  }

  return (
    <>
      {logs
        .filter((log) => !log.foreignWindow)
        .map((log) => (
          <LogWindow
            key={log.id}
            script={log.script}
            id={log.id}
            onClose={() => close(log.id)}
            onOpenExternally={() => openExternally(log)}
          />
        ))}
    </>
  );
}

interface IProps {
  script: RunningScript;
  id: string;
  onClose: () => void;
  onOpenExternally: () => void;
}

const useStyles = makeStyles((_theme: Theme) =>
  createStyles({
    titleButton: {
      padding: "1px 0",
      height: "100%",
    },
  }),
);

export const logBoxBaseZIndex = 1500;

function LogWindow(props: IProps): React.ReactElement {
  const draggableRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Draggable>(null);
  const [script, setScript] = useState(props.script);
  const [running, setRunning] = useState(workerScripts.has(script.pid));
  const classes = useStyles();
  const container = useRef<HTMLDivElement>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    updateLayer();
  }, []);

  useEffect(() => {
    const timerId = setInterval(() => setRunning(workerScripts.has(script.pid)), 100);
    return () => clearInterval(timerId);
  }, []);

  function updateLayer(): void {
    const c = container.current;
    if (c === null) return;
    c.style.zIndex = logBoxBaseZIndex + layerCounter + "";
    layerCounter++;
  }

  function maybeRunScript(): void {
    const newScript = run(script);
    if (newScript && script !== newScript) {
      setScript(newScript);
    }
  }

  function minimize(): void {
    setMinimized(!minimized);
  }

  function openExternally(): void {
    props.onOpenExternally();
  }

  // And trigger fakeDrag when the window is resized
  useEffect(() => {
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const onResize = debounce((): void => {
    const node = draggableRef?.current;
    if (!node) return;

    if (!isOnScreen(node)) {
      resetPosition();
    }
  }, 100);

  const isOnScreen = (node: HTMLDivElement): boolean => {
    const bounds = node.getBoundingClientRect();

    return !(bounds.right < 0 || bounds.bottom < 0 || bounds.left > innerWidth || bounds.top > outerWidth);
  };

  const resetPosition = (): void => {
    const node = rootRef?.current;
    if (!node) return;
    const state = node.state as { x: number; y: number };
    state.x = 0;
    state.y = 0;
    node.setState(state);
  };

  const boundToBody = (e: any): void | false => {
    if (e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight) return false;
  };

  // Max [width, height]
  const minConstraints: [number, number] = [250, 33];

  return (
    <Draggable handle=".drag" onDrag={boundToBody} ref={rootRef} onMouseDown={updateLayer}>
      <Box
        display="flex"
        sx={{
          flexFlow: "column",
          position: "fixed",
          left: "40%",
          top: "30%",
          zIndex: 1400,
          minWidth: `${minConstraints[0]}px`,
          minHeight: `${minConstraints[1]}px`,
          ...(minimized
            ? {
                border: "none",
                margin: 0,
                maxHeight: 0,
                padding: 0,
              }
            : {
                border: `1px solid ${Settings.theme.welllight}`,
              }),
        }}
        ref={container}
      >
        <ResizableBox
          height={500}
          width={500}
          minConstraints={minConstraints}
          handle={
            <span
              style={{
                position: "absolute",
                right: "-10px",
                bottom: "-16px",
                cursor: "nw-resize",
                display: minimized ? "none" : "inline-block",
              }}
            >
              <ArrowForwardIosIcon color="primary" style={{ transform: "rotate(45deg)", fontSize: "1.75rem" }} />
            </span>
          }
        >
          <LogWindowContent
            draggableRef={draggableRef}
            showLogs={!minimized}
            filename={script.filename}
            args={script.args}
            running={running}
            logs={script.logs}
            run={maybeRunScript}
            kill={() => kill(script)}
            close={props.onClose}
          >
            <Button className={classes.titleButton} onClick={minimize} onTouchEnd={minimize}>
              {minimized ? "\u{1F5D6}" : "\u{1F5D5}"}
            </Button>
            <Button className={classes.titleButton} onClick={openExternally} onTouchEnd={openExternally}>
              &#x2197;
            </Button>
          </LogWindowContent>
        </ResizableBox>
      </Box>
    </Draggable>
  );
}
