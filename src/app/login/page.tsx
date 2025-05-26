'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSignup) {
      // Signup
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username }, // Keep this, it can be useful
        },
      });

      if (signUpError) {
        setError(signUpError.message);
      } else if (data.user) {
        // IMPORTANT: Try to insert the profile.
        // It *might* work depending on Supabase version/config,
        // but it's better to handle it via triggers or after first login.
        // However, we MUST add the RLS policy.
        const { error: profileError } = await supabase.from('profiles').upsert({
          id: data.user.id,
          username,
        });

        if (profileError) {
            // Log the error, but don't block the user message
            console.error("Profile Upsert Error:", profileError.message);
            setError(`Signup successful, but profile creation failed: ${profileError.message}. Please try logging in or contact support.`);
        } else {
            // --- CHANGED BEHAVIOR ---
            // Don't redirect. Show a message.
            setError("Signup successful! Please check your email to confirm your account before logging in.");
            // Optionally, clear the form or switch back to login view
            setIsSignup(false);
            setEmail('');
            setPassword('');
            setUsername('');
            // router.push('/login'); // Or just stay and show the message
        }
      } else {
          setError("An unexpected issue occurred during signup. Please try again.");
      }

    } else {
      // Signin (Keep as is)
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setError(error.message);
      } else {
        router.push('/chat'); // Redirect on *successful sign-in*
      }
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-6">
        <h1 className="text-2xl font-bold text-center mb-6">
          {isSignup ? 'Sign Up' : 'Sign In'}
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignup && (
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
          )}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit"
            className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
          >
            {isSignup ? 'Sign Up' : 'Sign In'}
          </button>
        </form>
        <button
          onClick={() => setIsSignup(!isSignup)}
          className="w-full mt-4 text-blue-600 hover:underline"
        >
          {isSignup ? 'Switch to Sign In' : 'Switch to Sign Up'}
        </button>
        <button
          onClick={handleSignOut}
          className="w-full mt-2 text-gray-600 hover:underline"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}