import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import crewMark from '../../../build/crew-mark.png';

export function Message({ message }) {
  const user = message.role === 'user';
  return <article data-message-id={message.id} aria-label={user ? 'Your message' : 'Manager message'} className={`flex gap-3 ${user ? 'justify-end' : ''}`}>
    {!user && <img src={crewMark} alt="" className="mt-1 size-6 shrink-0" />}
    <div className={`min-w-0 max-w-full ${user ? 'rounded-2xl bg-muted px-4 py-3 sm:max-w-[85%]' : 'flex-1 pt-0.5'}`}>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{user ? 'You' : message.phase === 'commentary' ? 'Manager · progress' : 'Manager'}{message.status === 'streaming' && <span className="ml-2 font-normal">· Live</span>}{message.status === 'partial' && <span className="ml-2 font-normal">· {message.source === 'voice' ? 'Partial transcript' : 'Interrupted'}</span>}</p>
      <div className={`break-words text-sm leading-7 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_h1]:my-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-medium [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:w-full [&_th]:border-b [&_th]:p-2 [&_th]:text-left [&_td]:border-b [&_td]:p-2 ${message.phase === 'commentary' ? 'text-muted-foreground' : ''}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">{children}</a>, img: ({ alt }) => <span className="text-muted-foreground">{alt || 'Image'}</span>, table: ({ children }) => <div className="overflow-auto"><table>{children}</table></div> }}>{message.text || ''}</ReactMarkdown>
      </div>
    </div>
  </article>;
}

