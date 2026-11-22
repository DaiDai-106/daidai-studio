import type { ProjectInfo as Project } from "../../../../contracts/application.ts";
import { pluginModules } from "../../../../contracts/catalog.ts";
import { DaiMascot } from "../../../shared/components/dai_mascot.tsx";
import { Icon } from "../../../shared/components/icon.tsx";
import { ProjectModeIcon } from "./project_mode_icon.tsx";
import "../styles/project_home.css";

export function ProjectHome({
  projects,
  onCreate,
  onSelect,
}: {
  projects: Project[];
  onCreate: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="project-home">
      <div className="project-home-inner">
        <header className="project-home-header">
          <div className="project-home-heading">
            <div className="project-home-mascot" aria-hidden="true">
              <DaiMascot />
            </div>
            <div>
              <h1>项目</h1>
              <p>选择一个项目，继续工作。</p>
            </div>
          </div>
          <button type="button" className="project-home-create" onClick={onCreate}>
            <Icon name="plus" size={16} />
            新建项目
          </button>
        </header>
        <section className="project-home-projects" aria-labelledby="project-list-title">
          <div className="project-home-section-heading">
            <h2 id="project-list-title">项目列表</h2>
            <span className="project-home-count">{projects.length} 个项目</span>
          </div>
          {projects.length ? (
            <ul>
              {projects.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-label={`打开项目 ${item.name}`}
                    aria-description={pluginModules[item.mode]}
                    onClick={() => onSelect(item.id)}
                  >
                    <ProjectModeIcon
                      mode={item.mode}
                      size={18}
                      className="project-home-project-icon"
                    />
                    <span className="project-home-project-name">{item.name}</span>
                    <small>{pluginModules[item.mode]}</small>
                    <Icon name="chevron" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="project-home-empty">
              <span className="project-home-empty-icon">
                <Icon name="folder" size={20} />
              </span>
              <div>
                <strong>这里还没有项目</strong>
                <p>点击“新建项目”开始。</p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
