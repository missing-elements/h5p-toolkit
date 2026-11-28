# Route 0: this chat's H5P tools

This chat has the tools of an H5P server: `h5p_build`, which writes the `.h5p` into the user's
folders and checks it, or `h5p_play`, which checks the source and plays the activity in the chat,
with a download of the file. They are the build: run no command and download nothing.

- A type with no file here: `h5p_types` with the type gives its fields.
- What a file is before the source names it, a video's length or a picture's size: `h5p_media`
  with the file, where this chat has it.
- Call the tool with the source. Where it lists problems, fix each at its path and call it again.
- Every file the user attached in the chat, in this message or before, goes in `h5p_play`'s `files`
  as it is, however many: do not open them. The source names each by its file name.
- A package the user has is read into its source with `h5p_read`, where this chat has it.
- The tool's answer is the hand-over: give what it says to give, and no other address. Step 4 is
  not for this route.
