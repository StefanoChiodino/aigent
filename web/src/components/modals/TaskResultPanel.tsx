import React, { useMemo } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';
import { renderMarkdown } from '../../lib/markdown';

export function TaskResultPanel() {
  const task = useUIStore(s => s.taskResultTask);
  const setTaskResultTask = useUIStore(s => s.setTaskResultTask);
  const send = useConnectionStore(s => s.send);

  const rendered = useMemo(() => task?.result ? renderMarkdown(task.result) : '', [task?.result]);

  function defer() {
    setTaskResultTask(null);
  }

  function discuss() {
    defer();
    send({
      type: 'message',
      content: `Let's discuss the result of the background task: "${task!.description}"`,
    });
  }

  return (
    <div id="task-result-panel" className={task ? 'task-result-panel' : 'task-result-panel hidden'}>
      {task && (
        <>
          <div className="task-result-header">
            <span className="task-result-title">{task.description}</span>
          </div>
          <div className="task-result-body message-content" dangerouslySetInnerHTML={{ __html: rendered }} />
          <div className="task-result-footer">
            <button className="task-result-defer" onClick={defer}>
              Defer
            </button>
            <button className="task-result-discuss" onClick={discuss}>
              Discuss with agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}
