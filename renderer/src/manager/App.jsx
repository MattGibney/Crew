import { useCrewManager } from './useCrewManager.js';
import { WorkerAttention } from './WorkerAttention.jsx';
import { VoiceControls } from './VoiceControls.jsx';
import { WorkChat } from './WorkChat.jsx';
import { Transcript } from './Transcript.jsx';
import crewMark from '../../../build/crew-mark.png';

export function App() {
  const manager = useCrewManager();
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6 sm:py-14">
    <header className="space-y-3">
      <img src={crewMark} alt="Crew" width="48" height="48" />
      <p className="text-xs font-medium tracking-widest text-muted-foreground">CREW · LOCAL PROJECT INSTANCE</p>
      <h1 className="text-3xl font-semibold tracking-tight">Talk to your project manager.</h1>
      <p id="instance-project" className="text-sm text-muted-foreground" role="status">{manager.project}</p>
      <p className="text-sm text-muted-foreground">Live conversation through your existing ChatGPT sign-in.</p>
    </header>
    <WorkerAttention view={manager.orchestration} onReview={manager.reviewAttention} />
    <VoiceControls manager={manager} />
    <WorkChat work={manager.work} notice={manager.workNotice} onAnswer={manager.answerApproval} onStop={manager.stopManager} />
    <Transcript items={manager.transcript} />
    <p className="text-sm text-muted-foreground">This instance works only on its configured project. Workers act on explicitly agreed tickets and briefs; each uses an isolated worktree. Voice interruption stops speech; Stop manager work cancels the current manager turn, not an isolated worker.</p>
  </main>;
}
