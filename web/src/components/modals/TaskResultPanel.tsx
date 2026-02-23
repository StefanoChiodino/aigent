import React from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';

export function TaskResultPanel() {
  const task = useUIStore(s => s.taskResultTask);
  const setTaskResultTask = useUIStore(s => s.setTaskResultTask);
  const send = useConnectionStore(s => s.send);

  function close() {
    setTaskResultTask(null);
  }

  function discuss() {
    close();
    send({
      type: 'message',
      content: [
        `Let's discuss the result of the background task: "${task!.description}"`,
        '',
        task!.result ?? '',
      ].join('\n'),
    });
  }

  return (
    <div id="task-result-panel" className={task ? 'task-result-panel' : 'task-result-panel hidden'}>
      {task && (
        <>
          <div className="task-result-header">
            <span className="task-result-title">{task.description}</span>
            <button className="task-result-close" title="Close" onClick={close}>×</button>
          </div>
          <pre className="task-result-body">{task.result}</pre>
          <div className="task-result-footer">
            <button className="task-result-discuss" onClick={discuss}>
              Discuss with agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}
