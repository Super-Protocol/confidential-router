import type { Metadata } from 'next';
import { ChatScreen } from '../../../components/chat/chat-screen';
import { PageHeader } from '../../../components/page-header';

export const metadata: Metadata = { title: 'Chat' };

export default function ChatPage() {
  return (
    <>
      <PageHeader
        title="Chat"
        description="Talk to a served model from the console. The endpoint's evidence is checked in this browser before the first message leaves it, and every message is billed from credits like any API call."
      />
      <ChatScreen />
    </>
  );
}
