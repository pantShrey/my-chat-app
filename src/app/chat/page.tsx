'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { RealtimePostgresInsertPayload } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/client';
import { useRouter } from 'next/navigation';

type Message = {
  id: number | string; // Allow string for temp IDs
  content: string;
  created_at: string;
  sender_id: string;
  recipient_id: string | null;
  group_id: number | null;
};

type Profile = {
  id: string;
  username: string;
};

type Group = {
  id: number;
  name: string;
  created_at: string;
  created_by: string;
};

type ChatListItem =
  | { type: 'dm'; data: Profile; id: string }
  | { type: 'group'; data: Group; id: string };

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [selectedChat, setSelectedChat] = useState<ChatListItem | null>(null);
  const [allUsers, setAllUsers] = useState<Profile[]>([]);
  const [currentUser, setCurrentUser] = useState<Profile | null>(null);
  const [chatList, setChatList] = useState<ChatListItem[]>([]);

  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedUserIdsForGroup, setSelectedUserIdsForGroup] = useState<string[]>([]);

  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const fetchData = async () => {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user) {
        console.error('Error fetching auth user:', authError?.message);
        router.push('/auth/login');
        return;
      }

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('id', authData.user.id)
        .single();

      if (profileError || !profileData) {
        console.error('Error fetching current user profile:', profileError?.message);
        return;
      }
      setCurrentUser(profileData);

      const { data: usersData, error: usersError } = await supabase
        .from('profiles')
        .select('id, username');
      if (usersError) {
        console.error('Error fetching all users:', usersError.message);
      } else {
        setAllUsers(usersData || []);
      }

      // RLS on 'groups' (using is_user_in_group) handles filtering
      const { data: groupsData, error: groupsError } = await supabase
        .from('groups')
        .select('id, name, created_at, created_by');

      if (groupsError) {
        console.error('Error fetching groups:', groupsError.message);
      } else {
        const dmChatItems: ChatListItem[] = (usersData || [])
          .filter(user => user.id !== profileData.id)
          .map(user => ({ type: 'dm', data: user, id: `dm-${user.id}` }));

        const groupChatItems: ChatListItem[] = (groupsData || [])
          .map(group => ({ type: 'group', data: group, id: `group-${group.id}` }));

        setChatList([...dmChatItems, ...groupChatItems]);
      }
    };
    fetchData();
  }, [router]); // supabase is stable

  const handleRealtimeMessageCallback = useCallback((payload: RealtimePostgresInsertPayload<Message>) => {
    const incomingMessage = payload.new;
    console.log('Real-time message received by callback:', incomingMessage);

    if (!currentUser || !selectedChat) {
        console.log("Callback skipped: no current user or selected chat to match against.");
        return;
    }

    let isForActiveChat = false;
    if (selectedChat.type === 'dm') {
        const dmPartner = selectedChat.data as Profile;
        isForActiveChat = (
            (incomingMessage.sender_id === currentUser.id && incomingMessage.recipient_id === dmPartner.id) ||
            (incomingMessage.sender_id === dmPartner.id && incomingMessage.recipient_id === currentUser.id)
        ) && incomingMessage.group_id === null;
    } else if (selectedChat.type === 'group') {
        const group = selectedChat.data as Group;
        isForActiveChat = incomingMessage.group_id === group.id && incomingMessage.recipient_id === null;
    }

    if (!isForActiveChat) {
        console.log("Realtime message not for active chat, ignored by main callback logic:", incomingMessage, "Current active chat:", selectedChat);
        return;
    }

    const messageExists = (messages: Message[], newMessage: Message) =>
        messages.some(msg => msg.id === newMessage.id || (msg.id.toString().startsWith('temp-') && msg.content === newMessage.content && msg.sender_id === newMessage.sender_id));


    setMessages(prevMessages => {
        // If it's an incoming message from another user
        if (incomingMessage.sender_id !== currentUser.id) {
            if (messageExists(prevMessages, incomingMessage)) {
                return prevMessages;
            }
            return [...prevMessages, incomingMessage].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        } else {
            // It's our own message, confirmed by the backend. Replace temp or add if missing.
            let replaced = false;
            const updatedMessages = prevMessages.map(msg => {
                if (msg.id.toString().startsWith('temp-') &&
                    msg.sender_id === incomingMessage.sender_id &&
                    msg.content === incomingMessage.content // This is a weak link for matching temp
                ) {
                    replaced = true;
                    return incomingMessage;
                }
                if (msg.id === incomingMessage.id) { // Already have the confirmed message
                    replaced = true; // or handle as an update if content could change (not typical for chat)
                    return incomingMessage; // ensure it's the latest version
                }
                return msg;
            });

            if (!replaced && !messageExists(updatedMessages, incomingMessage) ) {
                 // If no temp message was found to replace, and it's not already there, add it.
                return [...updatedMessages, incomingMessage].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            }
            return updatedMessages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }
    });

  }, [currentUser, selectedChat]); // Dependencies

  useEffect(() => {
    if (!selectedChat || !currentUser) {
      setMessages([]);
      return () => { /* No cleanup needed if no subscription was made */ };
    }

    const fetchMessages = async () => {
      let query = supabase.from('messages').select('*');
      if (selectedChat.type === 'dm') {
        const dmPartner = selectedChat.data as Profile;
        query = query.or(
          `and(sender_id.eq.${currentUser.id},recipient_id.eq.${dmPartner.id},group_id.is.null),and(sender_id.eq.${dmPartner.id},recipient_id.eq.${currentUser.id},group_id.is.null)`
        );
      } else {
        const group = selectedChat.data as Group;
        query = query.eq('group_id', group.id).is('recipient_id', null);
      }
      const { data, error } = await query.order('created_at', { ascending: true });

      if (error) console.error('Error fetching messages:', error.message);
      else setMessages(data || []);
    };
    fetchMessages();

    let channel: ReturnType<typeof supabase.channel> | null = null;
    let channelName = '';

    const baseFilterOptions = {
        event: 'INSERT' as const,
        schema: 'public' as const,
        table: 'messages' as const,
    };

    if (selectedChat.type === 'dm') {
      const dmPartner = selectedChat.data as Profile;
      // Channel name must be globally unique enough for DMs, based on sorted user IDs
      channelName = `messages-dm-${[currentUser.id, dmPartner.id].sort().join('-')}`;
      channel = supabase.channel(channelName);
      channel.on<Message>(
        'postgres_changes',
        {
          ...baseFilterOptions,
          // RLS handles who gets what. This client filter is a secondary check for the *active* chat.
          // filter: `group_id=is.null&or=(and(sender_id.eq.${currentUser.id},recipient_id.eq.${dmPartner.id}),and(sender_id.eq.${dmPartner.id},recipient_id.eq.${currentUser.id}))`
          // Removing server-side filter for this to rely on RLS + client-side logic in callback
        },
        (payload) => {
            const msg = payload.new as Message;
            // Client-side validation that this message is for the *active* DM chat
            if (
                selectedChat && selectedChat.type === 'dm' && // Check again as selectedChat might change
                currentUser && (selectedChat.data as Profile).id && // Ensure dmPartner context is still valid
                (
                    (msg.sender_id === currentUser.id && msg.recipient_id === (selectedChat.data as Profile).id) ||
                    (msg.sender_id === (selectedChat.data as Profile).id && msg.recipient_id === currentUser.id)
                ) && msg.group_id === null
            ) {
                handleRealtimeMessageCallback(payload as RealtimePostgresInsertPayload<Message>);
            } else {
                 console.log('Realtime DM message filtered out by client subscription listener:', msg, "Current chat context:", selectedChat);
            }
        }
      );
    } else { // type === 'group'
      const group = selectedChat.data as Group;
      channelName = `messages-group-${group.id}`;
      channel = supabase.channel(channelName);
      channel.on<Message>(
        'postgres_changes',
        {
          ...baseFilterOptions,
          filter: `group_id=eq.${group.id}` // Server-side filter for this specific group_id
        },
        (payload) => { // Callback already filters by selectedChat in handleRealtimeMessageCallback
            handleRealtimeMessageCallback(payload as RealtimePostgresInsertPayload<Message>)
        }
      );
    }

    if (channel) {
        console.log(`Subscribing to ${channelName}`);
        channel.subscribe((status, err) => {
          console.log(`Subscription to ${channelName} status: ${status}`);
          if (err) console.error(`Subscription error on ${channelName}:`, err.message);
        });
    }

    return () => {
      if (channel) {
        console.log(`Unsubscribing from ${channelName}`);
        supabase.removeChannel(channel);
      }
    };
  }, [selectedChat, currentUser, handleRealtimeMessageCallback]); // supabase is stable


  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedChat || !currentUser) return;

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const messageCore = {
      content: newMessage,
      sender_id: currentUser.id,
    };

    let dbPayload: Pick<Message, 'content' | 'sender_id' | 'recipient_id' | 'group_id'>;

    if (selectedChat.type === 'dm') {
      dbPayload = { ...messageCore, recipient_id: (selectedChat.data as Profile).id, group_id: null };
    } else {
      dbPayload = { ...messageCore, group_id: (selectedChat.data as Group).id, recipient_id: null };
    }

    const tempMessage: Message = {
      ...dbPayload,
      id: tempId,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempMessage].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
    setNewMessage('');

    const { data, error } = await supabase
      .from('messages')
      .insert([dbPayload])
      .select()
      .single();

    if (error) {
      console.error('Error sending message:', error.message);
      setMessages((prev) => prev.filter((msg) => msg.id !== tempMessage.id));
      alert(`Error: ${error.message}`);
    } else if (data) {
      console.log('Message sent & confirmed by DB:', data);
      // Realtime callback should handle updating/replacing the temp message
      // But as a fallback, ensure it's correctly placed if realtime misses it or is slow
       setMessages((prev) => {
            const existing = prev.find(m => m.id === data.id);
            if (existing) return prev.map(m => m.id === data.id ? data : m).sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            return prev.map((msg) => (msg.id === tempMessage.id ? data : msg)).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
       });
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim() || !currentUser) return;

    console.log("Attempting to create group by user:", currentUser.id, "Group name:", newGroupName);
    const { data: { user: authUser } } = await supabase.auth.getUser();
    console.log("Current auth.uid() from Supabase at time of group creation:", authUser?.id);

    if (!authUser || currentUser.id !== authUser.id) {
        console.error("CRITICAL: currentUser.id in state does not match auth.uid()! This will likely fail RLS for group creation.");
        alert("Authentication mismatch. Please try logging out and in again, or refresh.");
        return;
    }

    try {
      const { data: groupData, error: groupError } = await supabase
        .from('groups')
        .insert({ name: newGroupName, created_by: currentUser.id })
        .select()
        .single();

      if (groupError) throw groupError;
      if (!groupData) throw new Error('Group creation returned no data.');

      const membersToInsert = [
        { group_id: groupData.id, user_id: currentUser.id },
        ...selectedUserIdsForGroup.map(userId => ({ group_id: groupData.id, user_id: userId })),
      ];
      const { error: membersError } = await supabase.from('group_members').insert(membersToInsert);
      if (membersError) {
        console.error("Error inserting group members, attempting to rollback group creation:", membersError);
        // Attempt to delete the just-created group if members fail
        await supabase.from('groups').delete().eq('id', groupData.id);
        throw new Error(`Failed to add members: ${membersError.message}. Group creation rolled back.`);
      }

      const newGroupChatItem: ChatListItem = { type: 'group', data: groupData, id: `group-${groupData.id}` };
      setChatList(prev => [...prev, newGroupChatItem]);
      setSelectedChat(newGroupChatItem);
      setMessages([]);

      setShowCreateGroupModal(false);
      setNewGroupName('');
      setSelectedUserIdsForGroup([]);
      console.log('Group created successfully:', groupData);

    } catch (error: any) {
      console.error('Error creating group:', error.message);
      alert(`Failed to create group: ${error.message}`);
    }
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) console.error('Error signing out:', error.message);
    router.push('/auth/login');
  };

  if (!currentUser) {
    return <div className="min-h-screen flex items-center justify-center"><p>Loading user data...</p></div>;
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-white rounded-lg shadow-lg flex h-[80vh]">
        {/* Sidebar */}
        <div className="w-1/3 border-r border-gray-200 p-4 overflow-y-auto flex flex-col">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold">Chats</h2>
            <button
              onClick={() => setShowCreateGroupModal(true)}
              className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
              title="Create new group"
            >
              + Group
            </button>
          </div>

          <h3 className="text-md font-semibold mt-2 mb-1 text-gray-700">Direct Messages</h3>
          {chatList.filter(chat => chat.type === 'dm').length === 0 && <p className="text-xs text-gray-500 pl-2">No direct messages.</p>}
          {chatList
            .filter(chat => chat.type === 'dm')
            .map((chat) => (
              <div
                key={chat.id}
                onClick={() => {
                  if (selectedChat?.id !== chat.id) setSelectedChat(chat);
                }}
                className={`p-2 cursor-pointer rounded-lg truncate ${
                  selectedChat?.id === chat.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
                }`}
              >
                {(chat.data as Profile).username}
              </div>
            ))}

          <h3 className="text-md font-semibold mt-4 mb-1 text-gray-700">Groups</h3>
          {chatList.filter(chat => chat.type === 'group').length === 0 && <p className="text-xs text-gray-500 pl_2">No groups joined.</p>}
          {chatList
            .filter(chat => chat.type === 'group')
            .map((chat) => (
              <div
                key={chat.id}
                onClick={() => {
                  if (selectedChat?.id !== chat.id) setSelectedChat(chat);
                }}
                className={`p-2 cursor-pointer rounded-lg truncate ${
                  selectedChat?.id === chat.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
                }`}
              >
                {(chat.data as Group).name}
              </div>
            ))}
        </div>

        {/* Chat Area */}
        <div className="w-2/3 flex flex-col">
          <div className="bg-blue-600 text-white p-4 rounded-t-lg flex justify-between items-center">
            <h1 className="text-xl font-bold truncate">
              {selectedChat
                ? selectedChat.type === 'dm'
                  ? `Chat with ${(selectedChat.data as Profile).username}`
                  : `Group: ${(selectedChat.data as Group).name}`
                : 'Select a chat'}
            </h1>
            <button onClick={handleSignOut} className="text-sm text-white hover:underline">
              Sign Out
            </button>
          </div>

          <div className="flex-1 p-4 overflow-y-auto">
            {selectedChat ? (
              messages.length > 0 ? (
                messages.map((message) => (
                  <div
                    key={message.id.toString()}
                    className={`mb-4 flex ${
                      message.sender_id === currentUser?.id ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div
                      className={`max-w-xs p-3 rounded-lg ${
                        message.sender_id === currentUser?.id
                          ? 'bg-blue-500 text-white'
                          : 'bg-gray-200 text-gray-800'
                      }`}
                    >
                      {selectedChat.type === 'group' && message.sender_id !== currentUser?.id && (
                        <p className="text-xs font-semibold mb-1 opacity-80">
                          {allUsers.find(u => u.id === message.sender_id)?.username || 'User'}
                        </p>
                      )}
                      <p>{message.content}</p>
                      <p className="text-xs opacity-70 mt-1 text-right">
                        {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center">No messages yet. Start the conversation!</p>
              )
            ) : (
              <p className="text-gray-500 text-center">Select a user or group to start chatting.</p>
            )}
            <div ref={messagesEndRef} />
          </div>

          {selectedChat && (
            <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-200 flex gap-2">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Send
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Create Group Modal */}
      {showCreateGroupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h3 className="text-xl font-bold mb-4">Create New Group</h3>
            <form onSubmit={handleCreateGroup}>
              <div className="mb-4">
                <label htmlFor="groupName" className="block text-sm font-medium text-gray-700 mb-1">
                  Group Name
                </label>
                <input
                  type="text"
                  id="groupName"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  className="w-full p-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-1">Add Members (optional)</label>
                <div className="max-h-48 overflow-y-auto border border-gray-300 rounded-lg p-2 space-y-1">
                  {allUsers
                    .filter(user => user.id !== currentUser?.id)
                    .map(user => (
                      <div key={user.id} className="flex items-center">
                        <input
                          type="checkbox"
                          id={`user-checkbox-${user.id}`}
                          checked={selectedUserIdsForGroup.includes(user.id)}
                          onChange={(e) => {
                            setSelectedUserIdsForGroup(prev =>
                              e.target.checked ? [...prev, user.id] : prev.filter(id => id !== user.id)
                            );
                          }}
                          className="mr-2 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <label htmlFor={`user-checkbox-${user.id}`} className="text-sm text-gray-700">
                          {user.username}
                        </label>
                      </div>
                    ))}
                    {allUsers.filter(user => user.id !== currentUser?.id).length === 0 && (
                        <p className="text-xs text-gray-500">No other users to add.</p>
                    )}
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateGroupModal(false);
                    setNewGroupName('');
                    setSelectedUserIdsForGroup([]);
                  }}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Create Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}