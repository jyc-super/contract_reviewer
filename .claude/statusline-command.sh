#!/usr/bin/env bash
# Claude Code status line — mirrors Git Bash PS1 style (git-prompt.sh)
# PS1 source: /c/Program Files/Git/etc/profile.d/git-prompt.sh
#   green  : user@host
#   purple : MSYSTEM (MINGW64)
#   yellow : working directory (\w)
#   cyan   : git branch (__git_ps1)
# Trailing "$" prompt character is intentionally omitted.

input=$(cat)

# --- Session data ---
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# --- user@host (green) ---
user=$(whoami 2>/dev/null || echo "user")
host=$(hostname -s 2>/dev/null || echo "host")
printf "\033[32m%s@%s\033[0m" "$user" "$host"

# --- MSYSTEM / platform label (purple) ---
msystem="${MSYSTEM:-MINGW64}"
printf " \033[35m%s\033[0m" "$msystem"

# --- Working directory (yellow) ---
# Use session cwd if available, else fall back to shell pwd
if [ -n "$cwd" ]; then
  display_dir="$cwd"
else
  display_dir="$(pwd)"
fi
# Convert Windows-style backslashes to forward slashes for display
display_dir="${display_dir//\\//}"
printf " \033[33m%s\033[0m" "$display_dir"

# --- Git branch (cyan, skip optional locks to avoid conflicts) ---
branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
if [ -n "$branch" ]; then
  printf " \033[36m(%s)\033[0m" "$branch"
fi

# --- Claude model (blue, dimmed separator) ---
if [ -n "$model" ]; then
  printf " \033[2m|\033[0m \033[34m%s\033[0m" "$model"
fi

# --- Context usage (color-coded) ---
if [ -n "$used" ]; then
  used_int=${used%.*}
  if [ "$used_int" -ge 80 ] 2>/dev/null; then
    printf " \033[31mctx:%s%%\033[0m" "$used_int"
  elif [ "$used_int" -ge 50 ] 2>/dev/null; then
    printf " \033[33mctx:%s%%\033[0m" "$used_int"
  else
    printf " \033[32mctx:%s%%\033[0m" "$used_int"
  fi
fi
