import { useState } from "react";
import { type Station, stations } from "../logic/demoStations.ts";
import "../styles/robot.css";

const positions: Record<string, { side: "left" | "right"; top: string }> = {
  "head-camera": { side: "right", top: "7%" },
  "left-arm": { side: "left", top: "29%" },
  "right-arm": { side: "right", top: "29%" },
  "wrist-camera": { side: "left", top: "52%" },
  "left-gripper": { side: "left", top: "75%" },
  "right-gripper": { side: "right", top: "75%" },
};

function Topology({
  station,
  selectedId,
  onSelect,
}: {
  station: Station;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="robot-topology">
      <svg viewBox="0 0 320 232" aria-hidden="true" className="robot-topology-art">
        <g className="robot-topology-lines">
          <path d="M160 38v18M160 111v57M127 72H99M193 72h28M112 120H74M108 157H74" />
          {station.id === "dual" && <path d="M208 157h38" />}
          <path d="M164 26h64" />
        </g>
        <g className="robot-body">
          <rect x="146" y="12" width="28" height="18" rx="5" />
          <circle cx="160" cy="21" r="4" />
          <rect x="138" y="55" width="44" height="82" rx="12" />
          <path d="M151 101h18M151 108h18M151 115h18" />
          <rect x="123" y="166" width="74" height="31" rx="9" />
          <rect x="134" y="176" width="52" height="10" rx="4" />
        </g>
        <g className="robot-arm-graphic">
          <path d="M136 69 122 69 108 90 116 112 109 137" />
          <circle cx="128" cy="69" r="9" />
          <circle cx="109" cy="90" r="8" />
          <circle cx="116" cy="112" r="7" />
          <rect x="100" y="135" width="19" height="14" rx="4" />
          <path d="M104 149v9l-4 4m15-13v9l4 4" />
        </g>
        {station.id === "dual" && (
          <g className="robot-arm-graphic">
            <path d="M184 69 198 69 212 90 204 112 211 137" />
            <circle cx="192" cy="69" r="9" />
            <circle cx="211" cy="90" r="8" />
            <circle cx="204" cy="112" r="7" />
            <rect x="201" y="135" width="19" height="14" rx="4" />
            <path d="M205 149v9l-4 4m15-13v9l4 4" />
          </g>
        )}
      </svg>
      {station.devices.map((device) => {
        const position = positions[device.id];
        if (!position) return null;
        return (
          <button
            type="button"
            key={device.id}
            className={`robot-node robot-node-${position.side}`}
            style={{ top: position.top }}
            aria-pressed={device.id === selectedId}
            aria-label={`${device.name}，${device.status === "connected" ? "已连接" : "已断连"}`}
            onClick={() => onSelect(device.id)}
          >
            <span className={`robot-status-dot ${device.status}`} />
            <span>{device.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RobotPanel({ concealed = false }: { concealed?: boolean }) {
  const [stationId, setStationId] = useState("dual");
  const [selectedId, setSelectedId] = useState("left-arm");
  const station = stations.find((item) => item.id === stationId) ?? stations[0];
  if (!station) return null;
  const selected = station.devices.find((device) => device.id === selectedId) ?? station.devices[0];
  if (!selected) return null;
  return (
    <aside className="robot-panel" aria-label="机器人设备" hidden={concealed}>
      <header className="robot-panel-heading">
        <span>机器人设备</span>
        <span className="robot-demo-tag">演示数据</span>
      </header>
      <div className="robot-panel-scroll">
        <div className="robot-intro">
          <div>
            <strong>设备工作站</strong>
            <p>查看设备组成与状态</p>
          </div>
          <span className="robot-demo-mode">演示模式</span>
        </div>
        <label className="robot-station-label" htmlFor="robot-station">
          演示工作站
        </label>
        <select
          id="robot-station"
          className="robot-station-select"
          value={station.id}
          onChange={(event) => {
            setStationId(event.target.value);
            setSelectedId("left-arm");
          }}
        >
          {stations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="robot-topology-heading">
          <strong>设备拓扑</strong>
          <span>点击选择设备</span>
        </div>
        <Topology station={station} selectedId={selected.id} onSelect={setSelectedId} />
        <p className="robot-topology-caption">示意图仅表示设备组成，不代表实际姿态</p>
        <section className="robot-device-detail" aria-label={`${selected.name}状态`}>
          <div className="robot-detail-heading">
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.kind === "arm" ? "机械臂" : selected.kind === "gripper" ? "夹爪" : "相机"}
              </span>
            </div>
            <span className="robot-device-status">
              <i className={`robot-status-dot ${selected.status}`} />
              {selected.status === "connected" ? "已连接" : "已断连"}
            </span>
          </div>
          {selected.joints ? (
            <>
              <div className="robot-detail-label">
                <span>关节位置</span>
                <span>{selected.joints.length} 个关节</span>
              </div>
              <dl className="robot-joints">
                {selected.joints.map((joint) => (
                  <div key={joint.name}>
                    <dt>{joint.name}</dt>
                    <dd>{joint.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="robot-device-info">{selected.detail}</p>
          )}
          <p className="robot-detail-footnote">
            {selected.status === "disconnected" ? "示例状态 · 读数已过期" : "示例状态 · 非实时数据"}
          </p>
        </section>
        <p className="robot-panel-note">当前为界面演示，尚未连接真实设备。</p>
      </div>
    </aside>
  );
}
