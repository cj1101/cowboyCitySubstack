<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Profile - Cowboy City</title>
    <link rel="stylesheet" href="./style.css">
    
    <!-- Firebase SDK v8 -->
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
    
    <!-- Quill Rich Text Editor -->
    <link href="https://cdn.quilljs.com/1.3.6/quill.snow.css" rel="stylesheet">
    <script src="https://cdn.quilljs.com/1.3.6/quill.js"></script>
</head>
<body>
    <!-- Layer 3: HUD (Fixed Admin Bar) -->
    <div id="hud" class="hud hidden">
        <div class="hud-title">Sheriff's Control Panel</div>
        <div class="hud-buttons">
            <button id="editPageBtn" class="btn btn-secondary">Edit Page</button>
            <button id="newPostBtn" class="btn btn-secondary">New Post</button>
            <button id="signOutBtn" class="btn btn-secondary">Sign Out</button>
        </div>
    </div>

    <!-- Profile Container -->
    <div class="profile-container">
        <!-- Layer 1: Design (User's live_html) -->
        <div id="designLayer" class="design-layer"></div>
        
        <!-- Layer 2: Feed (Glassmorphism Overlay) -->
        <div class="feed-layer">
            <div class="feed-container">
                <h2 class="feed-title">The Feed</h2>
                <div id="feedContainer">
                    <div class="loading">Loading posts...</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Editor Modal -->
    <div id="editorModal" class="modal-overlay hidden">
        <div class="modal">
            <div class="modal-header">
                <h2 class="modal-title">Edit Your Page</h2>
                <button class="modal-close" id="closeEditorBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="editorTextarea">HTML Code:</label>
                    <textarea id="editorTextarea" class="editor-textarea" placeholder="Enter your HTML code here..."></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" id="cancelEditorBtn">Cancel</button>
                <button class="btn" id="submitReviewBtn">Submit for Review</button>
            </div>
        </div>
    </div>

    <!-- New Post Modal -->
    <div id="newPostModal" class="modal-overlay hidden">
        <div class="modal">
            <div class="modal-header">
                <h2 class="modal-title">Create New Post</h2>
                <button class="modal-close" id="closePostBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="postTitle">Title:</label>
                    <input type="text" id="postTitle" placeholder="Enter post title...">
                </div>
                <div class="form-group">
                    <label for="postType">Type:</label>
                    <select id="postType">
                        <option value="lore">Lore</option>
                        <option value="forum">Forum</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="postBody">Body:</label>
                    <div id="postBodyEditor" style="min-height: 300px;"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" id="cancelPostBtn">Cancel</button>
                <button class="btn" id="createPostBtn">Create Post</button>
            </div>
        </div>
    </div>

    <script>
        // PHP to JS: Target username
        const targetUser = "<?php echo isset($_GET['u']) ? htmlspecialchars($_GET['u'], ENT_QUOTES, 'UTF-8') : ''; ?>";
    </script>
    <script src="./firebase_config.js"></script>
    <script src="./profile.js"></script>
    <script src="./editor.js"></script>
    <script src="./post_handler.js"></script>
</body>
</html>
